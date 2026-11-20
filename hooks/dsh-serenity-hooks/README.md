# 宁静号 ACC —— 给 DeepSeek Harness 装一个「认知容器」

> **一句话**：本插件把一个普通目录变成 AI 的**认知容器**。进去之后，它自带**记忆、纪律、工具和边界**——
> 中途换模型、重启机器、次日再来，都从上次停下的地方接着干。

## 1 它是什么 / 不是什么

| | |
|---|---|
| **是** | 一个 **DSH 插件**（npm `@shgroup/dsh-serenity-hooks`）：给宿主加工具、加拦截缝、加装配文本 |
| **是** | 一份**标准**的一个实现 —— 标准在 [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs)，本仓是它在 DSH 上的适配层 |
| **不是** | Agent 框架。不定义 agent loop、不选模型、不做 prompt 编排 —— 那是宿主的事 |
| **不是** | DSH 的替代或分支。**本插件从不修改宿主本体** |
| **不是** | 模型路由 / 网关。不代理模型请求，也不替你决定用哪个模型 |
| **不是** | 某个容器的私有产物。换一个符合标准的实现，同一个容器照常工作 |

**支持的宿主档位** = 包内 `package.json` 的 `peerDependencies`。
**当前版本 / 工具数 / 测试规模**：本文一律不写死 —— 版本看 [CHANGELOG.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/CHANGELOG.md)，运行态看 `dashboard health`。

### 三个概念（后面所有内容都建在这上面）

| 概念 | 是什么 | 住在哪 |
|---|---|---|
| **CCC**（Concrete Cognitive Container） | 一个目录 ＋ 一个 `.serenity` 标记。**没有标记，插件完全不介入** | 就是那个目录 |
| **认知轨迹**（cognitive trajectory） | 一段**长期工程**，不是一次性对话。它没有生命周期：不完成、不关闭、永存 | `AGENT_SESSIONS/<日期>--<编码>--<名字>/SESSION.md` |
| **会话**（session） | 轨迹的**可重建载体**。模型会换、上下文会满、进程会重启 —— 换掉载体，轨迹不动 | 宿主侧的会话日志 |

> 一句话读法：**身份属于轨迹，不属于任何一次会话。** 这条区分了整个插件的行为。

## 2 快速开始（2 分钟）

需要 Node ≥ 20（或 bun），以及一条受支持的 DSH 发布线。

```bash
# 1 装插件（自动加入 DSH 的 web profile）
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2 重启 dsh web（插件与网页端界面一起生效）
dsh web

# 3 验证：进到带 .serenity 标记的目录里开一个会话
#   · 会话开头自带容器身份与技能目录
#   · 标题旁出现状态胶囊（绿点 + SAFE 滑块）
#   · 输入 dashboard health：P1 / P2 / 配置 三项全通过
```

卸载：`dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

从源码安装（改代码时用）：

```bash
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks
```

⚠️ 不要用 `dsh plugin add github:…`：那个地址指向**仓库根**而不是插件包，装了不生效。

**容器就是一个目录 ＋ 一个标记文件**：

```
my-container/
├── .serenity            ← 标记：这个目录是一个容器（没有它，插件完全不介入）
├── .opencode/skills/    ← 领域技能：一个领域一份知识，可自带小工具
├── AGENT_SESSIONS/      ← 库房：每条认知轨迹一个目录，SESSION.md 是它的身体
└── _tmp/                ← 粘进对话的图片与文件落在这里
```

**安全模式**：拨动胶囊里的 SAFE 滑块 ⇒ `bash` 从 AI 的工具清单里**移除** —— 它看不见、也调不动。开关只在人这一侧。

## 3 装完多了什么

### 3.1 十三个工具（其中两个按条件出现）

> 这份清单**只在这里**（用户视角：能做什么）。**契约语义**（每个动作必须怎样）在标准的 §4，本文不复制。
> 增减以 `src/kernel/invariant.ts` 的 `REGISTERED_TOOLS` 为准 —— 那份常量由 `tests/compliance.test.ts` 与装配文本对读。

| 工具 | 能做什么 |
|---|---|
| `container_fs` | 容器内的文件操作：列目录 / 树 / 查找 / 复制 / 移动 / 新建 / 在文件管理器中打开。往容器外一步都出不去 |
| `cognitive_trajectory` | **一条认知轨迹**：它的身体（SESSION.md）+ 时间轴。建 / 看 / 切换 / 原地重建，以及**未来某刻唤醒**（`send-later`）与**即时递话**（`send-now`） |
| `dashboard` | 常开仪表：`health`（三项自检）/ `time` / `diag`（运行态诊断） |
| `container_git` | git：status / commit / push / log / pull / diff。**绝不自动强推** |
| `msm` | 小工具单入口：`msm("名字", ["参数"])`；记不全给候选；`inspect=true` 看用法 |
| `praxis` | 按需注入四套方法：`eap`（把话说清）/ `neat`（先对齐再动手）/ `cce`（连续性）/ `ontology`（把领域结构显式化） |
| `ontology` | 本体工程**引擎**：读 `.ttl`，做结构校验与语义审查、写模板。与 `praxis ontology` 一个说、一个跑 |
| `serenity-skill-creator` | 增强型技能的创建器：`guide` / `create` / `check` / `review` / `index` / `status` |
| `localstore` | 凭据与本地偏好：容器根的 `localstore.json`，默认拒绝入库 |
| `container_admin` | 机务舱：`config`（说明目录 / 轨迹约束 / 当前配置）＋ `msm`（注册表管理） |
| `browser_slot` | **浏览器槽位管理器**（最多 20 个独立 Chrome）：`acquire` / `list` / `release` ＋ 19 个页面动作（`ax` / `click` / `fill` / `wait` / `upload` / `dialog` …）。槽位有归属、有状态；忘了归还时**看守会反过来提醒占用它的会话** |
| `im-bridge` ● | 给联系人发消息（微信 / 飞书）：文本、文件、联系人、通道状态 |
| `diagram` ● | 标签源码 → 图，**进程内**光栅化并贴进对话（不起浏览器、不落文件） |

● = **按条件出现**。条件不满足时**根本注册都不给它**（AI 连看都看不到，也不占上下文）：`im-bridge` 要有已启用的 IM 通道；`diagram` 是实验性功能，**默认关**，开关在设置面板「工具」组。

> 🔴 **`reconstruct` 已于 2026-11-20 删除**（v1.137.12）：它的能力**全部**由 `cognitive_trajectory` 的 `rebuild` 承担 ——
> 累计用量超阈值时 `rebuild` 会**机械改道**成换代（另开新会话 ＋ 归档旧的）。两条路终点本来就是同一段代码，
> 留着第二个动作名只会让模型多一次犹豫。**换代能力一字未动，只是不再有第二个入口。**
> 若你曾经直接调它：改成调 `rebuild`（参数完全一样：`summary` 必填、`note` 可选），超阈值时行为等价。

> **运行态诊断**：`dashboard diag`（常驻可见，无需任何声明）—— live 会话 / 唤醒时钟 / CRO 已启用轨迹 / 唤醒注册表（未来与已过期分列）。

> **改名一律硬切、无兼容别名**：`cc_fs` → `container_fs`、`logbook` / `trajectory` → **`cognitive_trajectory`**、`eap` / `neat` / `cce` → `praxis`、`acc-diag` → **`dashboard diag`**。读到旧名时按此表换算。

> 🔴 **已退役的动作与键**（读到它们是**上游资料陈旧**，不是你配错了）：`container_fs` 的 `append`（v1.101.0 砍）／`dashboard` 的 `wait`（砍）／`exclusiveTools` 机制（砍）／`weixin.autoReplyWithLastMessage` 与 `weixin.fallbackOnNoSend`（D238 砍）。

### 3.2 机械约束（AI 绕不过去）

> 这是本插件的主要卖点：下面这些**不靠提示词劝阻**，靠机制。每一条你都能在自己那一侧观察到。

| 约束 | 你会看到什么 |
|---|---|
| **容器围墙** | 墙内可用，墙外一律拒绝 —— 路径连解析都不做 |
| **安全模式** | `bash` 从工具清单里消失（每一步都同步一次）；即使强行调用也被兜底拒绝 |
| **治理文件与黑名单** | `.serenity` 等治理文件禁止 AI 写入；其余路径黑名单可配置 |
| **凭据守卫** | `localstore.json` 对**所有**工具拒绝（含 read / grep / glob）⇒ 密钥值在结构上出不去 |
| **对外输出守卫** | 对外向的会话若答出敏感词 ⇒ **打回重答**，并告知命中的词与修改方向 |
| **进度提醒** | 做久了提醒 AI「把进度写回工作日志」，并要求它回一个确认码 —— 提醒是机制，不依赖自觉 |
| **日志体积治理** | `SESSION.md` 超过阈值 ⇒ 提醒重写（保留骨架 / 细节外移 / 可并则并）。阈值 `sessionKeeper.sessionMdMaxKB`，0 = 关 |
| **日志自动轮转** | 重建上下文时，把细粒度日志 `LOG/LOG.md` **整份冻结**成 `LOG-<时间戳>.md` 并开新代。**重名自动避让、永不覆盖**、冻结后回读校验字节数 |

> **为什么最后一条值得单列**：它原本是「提醒 AI 记得轮转」的一条纪律 —— 而纪律的失效形态是
> **AI 忘了、没有任何信号、日志无限长**。移到重建路径上之后，忘不忘都一样。

## 4 对外入口（可选）

| 入口 | 默认 | 用途 |
|---|---|---|
| DSH 主界面 | 3080 | 本机自用。**插件不碰这个端口**，也不起这个监听器 |
| 网页登录入口 | 3081（**默认关**） | 手机 / 外网访问完整界面：密码或 6 位动态验证码二选一，按账号失败锁定，登录后反代到 3080 |
| 微信主动发送口 | 3082（只绑 `127.0.0.1`） | 容器**外**的脚本用它发微信；容器内的 AI 不用它，直接用 `im-bridge` |
| 微信桥 | 无端口（出站长轮询） | 家人在微信里直接跟 AI 说话：扫码绑定，收文字 / 语音 / 图片 / 文件 |

- **会话挂在轨迹上**：同一条轨迹固定同一个会话，重启后历史还在（身份在人这一层之外）。
- **路由 = 微信号 → 轨迹编码**（精确匹配优先，`*` 兜底）。
- 默认只监听 `127.0.0.1`；要暴露到公网由你决定方式（隧道 / 反代 / 端口映射都行），插件不绑定任何一种。
- **程序化或远程接入走宿主自带的官方 ACP server**（`dsh --profile acp`，纯 stdio）：本插件不提供 ACP 面，认证放在接入层。

## 5 常见问题

**装完没反应？**
先确认你进的是带 `.serenity` 的目录 —— 不是容器，插件完全不介入。进去后输入 `dashboard health` 看三项自检。

**`bash` 怎么不见了？**
安全模式开着。这是设计，不是故障：关掉胶囊里的 SAFE 滑块就回来。

**3081 登录被锁了？**
连续失败 5 次锁 15 分钟起（指数退避）。等锁过期，或检查账号的验证码绑定状态。

**上下文快满了怎么办？**
先让 AI 把进度写回 `SESSION.md`，再按提示做原地重建（`cognitive_trajectory rebuild`）——**载体换掉，轨迹不动**，不用手动开新会话。

**怎么从手机 / 别的编辑器接进来？**
走宿主官方 ACP：`dsh --profile acp` 起服务，用任一 ACP 客户端连。认证与暴露范围由你那一侧的隧道 / 反代 / Access 决定，插件不发放 key。

**我在 DSH 里用 opencode 的模型，要手抄一串请求头吗？**
不用。插件只补 `x-opencode-session` 这一族**缺的**头，**你写过的值一律不动**；环境里有 `OPENCODE_API_KEY` 而一个 opencode 路由都没有时会自动建一条。不需要就关 `opencodeProvider.autoConfigure`。

**微信里 AI 的回复是怎么发出去的？**
由 **AI 自己发**（`im-bridge`）—— 这是现在**唯一**路径。桥只在两个方向上做事：把入站消息变成一轮对话，以及**当 AI 该发却没发时打回提醒**（最多 2 次）。它不替 AI 说话，也没有兜底转发开关（两个旧开关已退役，见 §3.1）。

**主动发的消息会被记录吗？**
会，跟回复走同一条记录通道，事件里用 `source` 区分。

**轨迹声明、定时唤醒、CRO 怎么配？**
本文不展开，各归其位：**声明面**（`trajectory.json` 能写什么、缺省是什么）在标准 §3.0.1；**工具自带手册**是 `container_admin config docs trajectory-self`（描述自己）与 `config docs trajectory-constraint`（限制自己）；**CRO 编写指南**是 `cognitive_trajectory cro-guide`。

## 6 延伸阅读

| 要什么 | 去哪 |
|---|---|
| **标准**：六条不变量、工具契约面、装配内容、拦截缝语义、验收清单 | [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) |
| **改了什么、为什么**（含当前版本号） | [CHANGELOG.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/CHANGELOG.md) |
| 为什么叫「认知容器」/「认知轨迹」 | [docs/cognitive-container-theory.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/cognitive-container-theory.md) |
| 轨迹声明面的完整判据 | [docs/trajectory-declaration-file.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/trajectory-declaration-file.md) |
| 代码地图 | [docs/codebase-overview-v1.22.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/codebase-overview-v1.22.md) |
| 维护者的判据库（本仓的维护纪律） | 维护技能 `dsh-serenity-plugin-development` |

### 面向插件开发者

```bash
pnpm typecheck   # 类型检查（node + 浏览器端两套）
pnpm test        # 全量测试（vitest）
pnpm build       # 打包（lib/index.js + client.js）
```

- 一条龙开发脚本 = `scripts/dsp-develop.ts`（typecheck / test / build / commit / push / version / bump / deploy / lockfile / host-upgrade / restart-web / publish / pack-check / github-push），子命令看 `--help`。
- 🔴 **改完 `package.json` 依赖必须跑 `lockfile` 并提交锁文件** —— 漏过一次，CI 从此一直红在「测试根本没跑」。
- **宿主类型基准 = devDependencies**：两份 `tsconfig` 的 `paths` 指向仓库内 `node_modules/@deepseek-ai/*`，由钉版 devDeps 提供 ⇒ **新增 `paths` 条目必须同时加 devDependency**；闸门是 `tests/compliance.test.ts`。
- **包内 README 是生成物**：仓根 `README.md` → `hooks/dsh-serenity-hooks/README.md`（`dsp-develop readme-sync`，相对链接转绝对 URL）。**不要手改包内那份。**

## 许可

MIT（见 [LICENSE](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/LICENSE)）
