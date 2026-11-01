# 宁静号 ACC —— 给 DeepSeek Harness 装一个「AI 工作区」

> **一句话**：本插件把一个普通目录变成 AI 的**工作区**。进去之后，它自带**记忆、纪律、工具和边界**——
> 中途换模型、重启机器、次日再来，都从上次停下的地方接着干。

## 1 它是什么 / 不是什么

| | |
|---|---|
| **是** | 一个 **DSH 插件**（npm `@shgroup/dsh-serenity-hooks`）：给宿主加工具、加拦截缝、加装配文本 |
| **是** | 一份**标准**的一个实现 —— 标准在 [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs)，本仓是它在 DSH 上的适配层 |
| **不是** | Agent 框架。不定义 agent loop、不选模型、不做 prompt 编排 —— 那是宿主的事 |
| **不是** | DSH 的替代或分支。**本插件从不修改宿主本体** |
| **不是** | 模型路由 / 网关。不代理模型请求，也不替你决定用哪个模型 |
| **不是** | 某个工作区的私有产物。换一个符合标准的实现，同一个工作区照常工作 |

**支持的宿主档位** = 包内 `package.json` 的 `peerDependencies`（现为 `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1` 三档并行；加档减档以该文件为准）。
**当前版本 / 工具数 / 测试规模**：本文一律不写死 —— 版本看 [CHANGELOG.md](CHANGELOG.md)，运行态看 `dashboard health`。

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

**工作区 = 一个目录 + 一个标记文件**：

```
my-workspace/
├── .serenity            ← 标记：这个目录是一个工作区（没有它，插件完全不介入）
├── .opencode/skills/    ← 领域技能：一个领域一份知识，可自带小工具
├── AGENT_SESSIONS/      ← 库房：每条认知轨迹一个目录，SESSION.md 是它的身体
└── _tmp/                ← 粘进对话的图片与文件落在这里
```

**安全模式**：拨动胶囊里的 SAFE 滑块 ⇒ `bash` 从 AI 的工具清单里**移除** —— 它看不见、也调不动。开关只在人这一侧。

## 3 装完多了什么

### 3.1 十二个工具（其中两个按条件出现）

> 这份清单**只在这里**（用户视角：能做什么）。**契约语义**（每个动作必须怎样）在标准的 §4，本文不复制。

| 工具 | 能做什么 |
|---|---|
| `container_fs` | 工作区内的文件操作：列目录 / 树 / 查找 / 复制 / 移动 / 新建 / 追加 / 在文件管理器中打开。往工作区外一步都出不去 |
| `cognitive_trajectory` | **一条认知轨迹**：它的身体（SESSION.md）+ 时间轴。建 / 看 / 切换 / 原地重建，以及**未来某刻唤醒**（`send-later`）与**即时递话**（`send-now`） |
| `dashboard` | 常开仪表：`health`（三项自检）/ `time` / `wait` |
| `container_git` | git：status / commit / push / log / pull / diff。**绝不自动强推** |
| `msm` | 小工具单入口：`msm("名字", ["参数"])`；记不全给候选；`inspect=true` 看用法 |
| `praxis` | 按需注入四套方法：`eap`（把话说清）/ `neat`（先对齐再动手）/ `cce`（连续性）/ `ontology`（把领域结构显式化） |
| `ontology` | 本体工程**引擎**：读 `.ttl`，做结构校验与语义审查、写模板。与 `praxis ontology` 一个说、一个跑 |
| `serenity-skill-creator` | 增强型技能的创建器：`guide` / `create` / `check` / `review` / `index` / `status` |
| `localstore` | 凭据与本地偏好：工作区根的 `localstore.json`，默认拒绝入库 |
| `container_admin` | 机务舱：`config`（说明目录 / 轨迹约束 / 当前配置）＋ `msm`（注册表管理） |
| `im-bridge` ● | 给联系人发消息（微信 / 飞书）：文本、文件、联系人、通道状态 |
| `diagram` ● | 标签源码 → 图，**进程内**光栅化并贴进对话（不起浏览器、不落文件） |

● = **按条件出现**。条件不满足时**根本不注册**（AI 连看都看不到，也不占上下文）：`im-bridge` 要有已启用的 IM 通道；`diagram` 是实验性功能，**默认关**，开关在设置面板「工具」组。

> **运行态诊断**（v1.106.0 起）：原独立工具 `acc-diag` 已并入 **`dashboard` 的 `diag` 动作**（常驻可见，无需任何声明）——live 会话 / 唤醒时钟 / CRO 已启用轨迹 / 唤醒注册表（未来与已过期分列）。`exclusiveTools` 机制同批删除。

> **改名一律硬切、无兼容别名**：`cc_fs` → `container_fs`、`logbook` / `trajectory` → **`cognitive_trajectory`**、`eap` / `neat` / `cce` → `praxis`。读到旧名时按此表换算。

### 3.2 机械约束（AI 绕不过去）

> 这是本插件的主要卖点：下面这些**不靠提示词劝阻**，靠机制。每一条你都能在自己那一侧观察到。

| 约束 | 你会看到什么 |
|---|---|
| **工作区围墙** | 墙内可用，墙外一律拒绝 —— 路径连解析都不做 |
| **安全模式** | `bash` 从工具清单里消失（每一步都同步一次）；即使强行调用也被兜底拒绝 |
| **治理文件与黑名单** | `.serenity` 等治理文件禁止 AI 写入；其余路径黑名单可配置 |
| **凭据守卫** | `localstore.json` 对**所有**工具拒绝（含 read / grep / glob）⇒ 密钥值在结构上出不去 |
| **对外输出守卫** | 对外向的会话（受限轨迹 / 重建会话）若答出敏感词 ⇒ **打回重答**，并告知命中的词与修改方向 |
| **进度提醒** | 做久了提醒 AI「把进度写回工作日志」，并要求它回一个确认码 —— 提醒是机制，不依赖自觉 |
| **日志体积治理** | `SESSION.md` 超过阈值 ⇒ 提醒重写（保留骨架 / 细节外移 / 可并则并）。阈值 `sessionKeeper.sessionMdMaxKB`，0 = 关 |
| **重建前交接** | 重建上下文前，先把「做到哪 / 差什么 / 下一步」写进轨迹目录的 `REBUILD-TODO.md`；重建后的自己先读它 |

## 4 对外入口（可选）

| 入口 | 默认 | 用途 |
|---|---|---|
| DSH 主界面 | 3080 | 本机自用。**插件不碰这个端口**，也不起这个监听器 |
| 网页登录入口 | 3081（**默认关**） | 手机 / 外网访问完整界面：密码或 6 位动态验证码二选一，按账号失败锁定，登录后反代到 3080 |
| 微信主动发送口 | 3082（只绑 `127.0.0.1`） | 工作区**外**的脚本用它发微信；工作区内的 AI 不用它，直接用 `im-bridge` |
| 微信桥 | 无端口（出站长轮询） | 家人在微信里直接跟 AI 说话：扫码绑定，收文字 / 语音 / 图片 / 文件 |

- **会话挂在轨迹上**：同一条轨迹固定同一个会话，重启后历史还在（身份在人这一层之外）。
- **路由 = 微信号 → 轨迹编码**（精确匹配优先，`*` 兜底）。
- 默认只监听 `127.0.0.1`；要暴露到公网由你决定方式（隧道 / 反代 / 端口映射都行），插件不绑定任何一种。
- **程序化或远程接入走宿主自带的官方 ACP server**（`dsh --profile acp`，纯 stdio）：本插件不提供 ACP 面，认证放在接入层。

## 5 常见问题

**装完没反应？**
先确认你进的是带 `.serenity` 的目录 —— 不是工作区，插件完全不介入。进去后输入 `dashboard health` 看三项自检。

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
默认由插件把它最后一段话转给用户；配 `autoReplyWithLastMessage: false` 后改由 AI 自己发（`im-bridge`），该发没发会被打回提醒（最多 2 次），再开 `fallbackOnNoSend` 可让插件兜底转达。

**主动发的消息会被记录吗？**
会，跟回复走同一条记录通道，事件里用 `source` 区分 `reply` / `proactive` / `reply-fallback`。

**轨迹声明、定时唤醒、CRO 怎么配？**
本文不展开，各归其位：**声明面**（`trajectory.json` 能写什么、缺省是什么）在标准 §3.0.1；**工具自带手册**是 `container_admin config docs trajectory-self`（描述自己）与 `config docs trajectory-constraint`（限制自己）；**CRO 编写指南**是 `cognitive_trajectory cro-guide`。

## 6 延伸阅读

| 要什么 | 去哪 |
|---|---|
| **标准**：六条不变量、工具契约面、装配内容、拦截缝语义、验收清单 | [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) |
| **改了什么、为什么**（含当前版本号） | [CHANGELOG.md](CHANGELOG.md) |
| 为什么叫「认知容器」/「认知轨迹」 | [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) |
| 轨迹声明面的完整判据 | [docs/trajectory-declaration-file.md](docs/trajectory-declaration-file.md) |
| 代码地图 | [docs/codebase-overview-v1.22.md](docs/codebase-overview-v1.22.md) |
| 维护者的判据库（本仓的维护纪律） | 维护技能 `dsh-serenity-plugin-development` |

### 面向插件开发者

```bash
pnpm typecheck   # 类型检查（node + 浏览器端两套）
pnpm test        # 全量测试（vitest）
pnpm build       # 打包（lib/index.js + client.js）
```

- 一条龙开发脚本 = `scripts/dsh-develop.ts`（typecheck / test / build / commit / push / version / bump / deploy / lockfile / host-upgrade / restart-web / publish / pack-check / github-push），子命令看 `--help`。
- 🔴 **改完 `package.json` 依赖必须跑 `lockfile` 并提交锁文件** —— 漏过一次，CI 从此一直红在「测试根本没跑」。
- **宿主类型基准 = devDependencies**：两份 `tsconfig` 的 `paths` 指向仓库内 `node_modules/@deepseek-ai/*`，由钉版 devDeps 提供 ⇒ **新增 `paths` 条目必须同时加 devDependency**；闸门是 `tests/compliance.test.ts`。
- **包内 README 是生成物**：仓根 `README.md` → `hooks/dsh-serenity-hooks/README.md`（`dsh-develop readme-sync`，相对链接转绝对 URL）。**不要手改包内那份。**

## 许可

MIT（见 [LICENSE](LICENSE)）
