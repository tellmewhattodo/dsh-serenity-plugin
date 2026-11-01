/**
 * tools/msm/service.ts — msm 纯操作层（acc_msm → msm 执行 + container_admin 管理面，v1.30；零 DSH 依赖）
 *
 * MSM（Mech & Semi-Mech）框架：exec 执行 / register|deregister|check 管理。
 * 复用 CCC 的 mech-registry.json（v1 或数组格式）。cwd 钉在 CCC 根。
 */

import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { execFileSync, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, relative, resolve } from 'node:path'
import { platform } from 'node:process'
import { classifyPath, readCccName as readCccNameFromCcc } from '../../kernel/ccc.js'
import { ACC_VERSION } from '../../kernel/constants.js'
import { weixinSendEndpoint } from '../../im/endpoint.js'
import type { JsonValue } from '../../kernel/json.js'

const execFileAsync = promisify(execFile)

const MSM_TIMEOUT_MS = 600_000

// ── Windows bun 真路径探测：裸 'bun'/'.cmd' 在 CreateProcess 下不可 spawn（EINVAL/ENOENT）──
// 优先定位真 bun.exe（PE）绝对路径 → 零 shell、argv 保真；命中失败返回 null → 走 npx shell 兜底。
const BUN_EXE_CANDIDATES: ReadonlyArray<() => string> = [
  // 官方安装器：~\.bun\bin\bun.exe
  () => join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.bun', 'bin', 'bun.exe'),
  // npm 包装包：%APPDATA% 或 %LOCALAPPDATA% 下 node_modules\bun\bin\bun.exe
  () => join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
  () => join(process.env['LOCALAPPDATA'] ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
]
let bunExeCache: string | null | undefined
function bunExecutablePath(): string | null {
  if (bunExeCache !== undefined) return bunExeCache
  if (platform !== 'win32') { bunExeCache = 'bun'; return bunExeCache }
  for (const cand of BUN_EXE_CANDIDATES) {
    try {
      if (existsSync(cand())) { bunExeCache = cand(); return bunExeCache }
    } catch { /* 单个候选失败继续 */ }
  }
  bunExeCache = null
  return null
}

/** CCC 名：从 .serenity 解析（review P2-2 统一收口到 kernel/ccc.ts readCccName——跳 # 注释/空行首非空行；此处保留导出名兼容内部调用） */
function readCccName(root: string): string | null {
  return readCccNameFromCcc(root)
}

/**
 * path-arg 逃逸校验：根内 + symlink 防御（对齐 osp validatePathArgsFromTokens）。
 * symlink 指向根外 → 拒绝（realpath 解析后与根前缀比对）。
 */
function assertPathInsideRoot(root: string, value: string, flagName: string): void {
  const abs = resolve(root, value)
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: --${flagName}=${value} escapes the CCC root`)
  }
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs)
      if (classifyPath(real, root) === 'outside') {
        throw new Error(`Path escape blocked: --${flagName}=${value} resolves via symlink outside the root (${real})`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('symlink')) throw e
      /* realpath 失败（权限等）放行——后续执行会报错 */
    }
  }
}

/**
 * 业务子进程 env：注入 SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION（对齐 osp）
 * + SERENITY_WEIXIN_API（v1.30.9：微信主动发送入口地址——MSM 脚本零硬编码端口；
 *   未启动则不注入，脚本回退默认值）。
 */
function buildMsmEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SERENITY_ROOT: root,
    SERENITY_CCC: readCccName(root) ?? '',
    SERENITY_VERSION: ACC_VERSION,
  }
  const weixinApi = weixinSendEndpoint()
  if (weixinApi) env.SERENITY_WEIXIN_API = weixinApi
  return env
}

/**
 * Windows 兼容（审计观察点 A）：`.cmd` 不能直接被 CreateProcess 解析——
 * `execFile('npx')` / `spawnSync('npx')` 在 Windows 必 ENOENT（需 shell 或显式 .cmd）。
 * bun 无扩展名（bun.exe 可被 libuv 按 PATHEXT 解析），保持 'bun'。
 */
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx'

type MsmAction = 'list' | 'exec' | 'register' | 'deregister' | 'check' | 'guide' | 'ccc-config' | 'catalog'

export const MSM_ACTIONS: readonly MsmAction[] = ['list', 'exec', 'register', 'deregister', 'check', 'guide', 'ccc-config', 'catalog']

/**
 * ACC 能力目录（需求④ S142 用户拍板："acc 配置各自做 guide 越来越多，整合成目录式使用指南"）。
 * 目录在前、详情各归各——**单一真相源**：本目录只索引"去哪个工具/子命令看详情"，不复制详情
 * （避免 container_admin/weixin-doctor 等 guide 全文重复 → 多真相源 → 失同步）。
 * 后续新增功能只需在此加一行（低熵可演进）。
 *
 * 🔴 **2026-10-19 v1.75.0 起导出**：它是 `container_admin config docs catalog` 那一章的正文。
 * `msm catalog` 动作**降为指针**（只指路，不再返回本常量）—— 否则同一份正文会有两个入口，
 * 而"两个入口返回同一份内容"正是本目录自己反对的形态。
 */
export const ACC_CATALOG = `═══ ACC Usage Catalog ═══
Directory of ACC capabilities — each area lists where to go for details (guides live with their feature; this catalog only points).

  ① 轨迹本体          → cognitive_trajectory（list/show/create/use + rebuild 超限重建 + send-now 即时投递 + send-later 未来一次性唤醒
                          + cro-guide CRO 编写指南）
                         原 logbook 已并入（v1.33 用户裁决：废除 logbook 词）；close/archive 删（归档走 container_fs mv），
                         health/qa/summary 分别并入 use / list，hook-develop-guide 并进 container_admin msm guide
  ② 认知质量框架      → praxis（eap/neat/cce/ontology 四合一——可实践理论注入，section 渐进披露，无参即目录）
                          ontology（v1.52 D121：本体工程**引擎**——init/check/explain/verify/review/compliance；
                          与 praxis ontology 的分工 = 那个是**方法文本**、这个是**能跑的那个**）
  ③ 工具与执行        → container_fs（容器文件系统 15 子命令）/ container_git（git）/ dashboard（health 含注册表检查/time/wait）
                         acc_msm 已并入 msm（执行+发现）与 container_admin（管理）——msm("<name>", ["<args>"])；inspect=true 查用法
                         （v1.106.0 已删 exclusiveTools 机制：原专属工具 acc-diag **已并入 dashboard diag**）
  ④ 轨迹约束与对外面  → container_admin config（轨迹约束四动作 guide/validate/apply/list——**原 role 域已并入 config**，旧名作过渡别名仍可用；说明类配置走**两层菜单** config docs 目录 ／ config docs <章节> 详情）
                         外部程序化接入用官方 dsh --profile acp
                         ＋ 现成 ACP 客户端；本插件不提供 ACP 面
  ⑤ 自主与接入        → cognitive_trajectory send-now（跨轨迹的**即时**递送，**不排队**：live 目标在跑就当场注入当前轮、空闲则立即起轮；非 live 冷载入——等效于直接 wake；**有同步回执**）
                         cognitive_trajectory send-later（跨轨迹的"未来时刻 + 一条 message"；fire-and-forget，无回执无回收）
                         weixin 微信桥（配置/扫码/路由/消息 hook——CCC 侧 weixin-doctor MSM：msm("weixin-doctor", ["guide"])）
  ⑥ CCC 配置总览      → container_admin config docs config（按章详情——8 段全表）
                          或 container_admin msm ccc-config（同一份正文的旧入口，保留）
  ⑦ 注册表与安全      → mech-registry.json 由 container_admin msm register/deregister 管理（写保护——不可直接编辑）
                         dashboard health 输出 registry 完整性检查；损坏恢复指引见 health registry.issues
                         CCC 级开关：safeMode.blacklist（写路径黑名单）
                         / safeMode.hiddenTools（**安全模式开启期间**额外隐藏的工具，v1.51.4）
                         CCC 级 skill 供给：cognitiveTrajectory.skills（v1.44.0——**本 CCC 每条轨迹都带**，含 轨迹约束会话；与轨迹自己的 frontmatter 声明取并集）

每区：一句话定位 + 详细入口（工具名 / guide 子命令）。详情永远以对应工具的 guide/ccc-config 为单一真相源。
`

import { docsPointer } from '../config-docs.js'

export const MSM_GUIDE = `MSM Development Manual (Mech & Semi-Mech framework)

## What it is
MSM = the executable-unit layer. Mech is pure TS with zero LLM reasoning; Semi-Mech is a TS framework + LLM decision points.
MSM is ACC's deterministic executable-unit layer — all shell/exec operations go through MSM and cannot be bypassed.

## Registering a new MSM (container_admin msm register)
1. Write the script under <skill>/scripts/ (runnable via tsx; must include a main() CLI guard with an import.meta.url check)
2. container_admin msm register --domain msm --action register <name> --skill <s> --path <script path relative to root> --category <mech|semi-mech> --description <desc>
3. Auto-writes mech-registry.json (preserving the original format) + git commit (commits only the registry file)
4. Validation: path must be inside root, script must exist, name must be globally unique

## flag schema (v1)
flags is a new-style object array for parameter validation and path-escape guarding:
  [{"name":"output","type":"string","description":"output path"},
   {"name":"target","type":"path","description":"operation target (type:path enables in-root validation + symlink defense)"},
   {"name":"force","type":"boolean","description":"force mode","default":false}]
- {name, type} format — new style, type:"path" enables the path-escape guard
- {flag, description} format — old style, CLI flag description string
- On registration, flags are passed via container_admin msm register --flags '<json>'

## Script conventions
- Top-of-file documentation: purpose / usage / exit codes
- Exit codes: 0 success / 1 user / 2 system / 3 operator (per ACC protocol classification)
- main() CLI guard (DC-M2): the script must start with
    if (import.meta.url === \`file://\${process.argv[1]}\`) { main() }
  or an equivalent isMain / require.main === check — so vitest imports never trigger top-level code
- A paired .test.ts or .spec.ts (DC-M1, vitest)
- Business subprocess environment: SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION injected

## Interaction & confirmation conventions (no blocking confirmation)
- MSMs run in **user-less subprocesses** (spawn/execFile, 600s timeout) — **never** use
  readline / prompt / process.stdin etc. to block waiting for user input (it would hang until killed by the timeout)
- When a second confirmation is needed: **directly return the confirmation request** (list the operation to perform and its impact + how to retry with the confirmation flag),
  returning a non-zero exit code (or an explicit hint)
- After the agent confirms, **re-invoke the MSM with the confirmation flag** (e.g. --confirm / --yes / --force) to retry
- Standard mode (two-phase):
  1. First call: destructive/confirmation-requiring operation detected and no confirmation flag present → output the confirmation request (list operation/impact/rollback),
     exit non-zero (e.g. 1 user), **perform no changes**
  2. After the agent evaluates, re-invoke: with the confirmation flag → execute and output the result
- Applies to: delete/overwrite/push/batch operations and other irreversible or wide-impact operations
- Anti-example (forbidden): readline waiting for user input, process.stdin.on('data') blocking waits
  (MSMs have no stdin interaction channel — they hang until the 600s timeout)

## Quality checks (container_admin msm check, DC-M1~M4)
DC-M1 has .test.ts/.spec.ts; DC-M2 has a main() guard (function main( / isMain / require.main === / import.meta.url);
DC-M3 bidirectional: scripts unregistered + registry references missing scripts; DC-M4 path-type flags marked type:"path"

## Self-description (protocol flags, first argument only)
msm("<name>", ["--list"])           — list all MSMs
msm("<name>", ["--schema", "<n>"])  — view a specific MSM's parameter schema
msm("<name>", ["--format=json"])    — JSON output mode (remaining args passed through losslessly)
`

/**
 * CCC 配置参考（对齐 osp ccc-config action）。
 *
 * 🔴 **2026-10-19 起导出**：`container_admin config docs config` 的两层菜单把它作为
 * 「config」章正文返回。**不另写一份**——同一段说明有第二份副本就会漂（本轨反复踩过）。
 */
export const CCC_CONFIG_REFERENCE = `═══ CCC Configuration Reference ═══

CCC-level features are configured in .opencode/serenity.json.
Below are all available configuration sections.

── 1. sessionKeeper.threshold / sessionKeeper.sessionMdMaxKB ──
cognitive-trajectory-assistant（COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT）提醒机制的积分阈值（非 headless 主 agent）。
按工具调用加权 + 耗时计分；达到阈值注入提醒，要求模型回复 ACK 码。

  Config:
    { "sessionKeeper": { "threshold": 150, "sessionMdMaxKB": 100 } }

  计分：write/edit = 3，task = 10，read/grep/glob/msm 等 = 1，时间 = 1/分钟
  默认：150

  ▸ sessionMdMaxKB（v1.31.1 新增；v1.31.2 100→200；🔴 v1.84.0 200→100）：
    **活跃 SESSION.md 体积上限（KB，缺省 100；0 = 关闭）**。
    超过 → 注入 [COGNITIVE-TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION] 提醒：暂停当前工作 →
    加载 eap（praxis eap）→ **按 EAP 重构整个 SESSION.md**（v1.84.0 起；旧版是四条重写原则）。
    判据 = EAP 三个变量：E↑ 变量/边界/有向关系全显式 ｜ R↓ 带理由与被否项，长证据链外移到
    references/*.md（SESSION.md 留链接）｜ S↑ 结构每次同样重建，不是时间流水账。
    两条硬约束随提醒给出：保留固定段落的**顺序与标题**（与系统提示词对齐）+ 保留顶部 frontmatter。
    超限后每次工具调用都提醒；连续 3 次未重写 → 升级强制语气；
    文件回到限内 → 自动停止（自愈）。轨迹提醒**不机械阻断工作**（与 rebuild 提醒同族）。

── 2. localstore.gitTrack ──
localstore.json 的 git 策略：allow 可提交 / deny 禁提交（默认 deny）。
deny 时写入自动确保 .gitignore 含该文件（物理保证），container_git commit 会检查拒绝。

  Config:
    { "localstore": { "gitTrack": "allow" } }

── 3. hooks.autoRestoreSession ──
会话自动恢复（默认 true；受 events 门控——仅根会话 + 已有对话历史才恢复）。

  Config:
    { "hooks": { "autoRestoreSession": false } }

── 4. safeMode（黑名单 ＋ 开启期间隐藏的工具）──
safe-mode 由 WebUI 开关控制（写 .serenity-safe-on 标记）；黑名单路径受 guards seam 拦截。

  ▸ blacklist：写路径黑名单（同下 Config）。
  ▸ hiddenTools（v1.51.4，owner 2026-10-09 令）：**仅在安全模式开启期间**额外从模型工具
    清单隐藏的工具（ACC 基础表恒隐 bash）。打开 safe-mode 生效、**关掉即全部恢复**；
    改本键**热生效**（下一个 pre-step 重算，无需重启）。声明在 CCC（D23）——ACC 代码里
    不出现任何具体工具名。
    ⚠️ 写一个**本 CCC 未注册**的名字会让**整次 restrict 失败**（DSH 契约逐字："unknown
    names … fail"）⇒ 此时**退化为只隐藏基础表**并在日志响亮报错（绝不因一个错名丢掉
    safe-mode 的核心隐藏）。诊断：\`AGENT_SESSIONS/.restrict-diag.json\` 的 \`denyByKey\`。
    ⚠️ 隐藏 = **从 schema 移除**（agent 根本看不到该工具）⇒ 别把 skill/文档还在教的工具写进来。

  Config:
    { "safeMode": { "blacklist": [".secrets/"], "hiddenTools": ["workflow", "job_kill"] } }

── 5. 轨迹约束.roles（F4 认知子集角色）──
轨迹约束角色 = 全知全能 cognitive trajectory 的任意子集（CCC 定义）。每角色独立模型 + 双白名单
（MSM 白名单 msms[] 与非 MSM 工具白名单 tools[]，白名单外全隐藏；skill 加载恒可用）。
cognitive trajectory 纪律子集（session/keeper/rebuild 参与项）默认全关 = 完全独立。
systemPrompt 内联 或 systemPromptFile（.md 引用，推荐）——角色会话的完整人格/边界提示词。
validate 校验 / apply 生效 / list 查看：container_admin config <guide|validate|apply|list>（原 role 域已并入 config，旧名作过渡别名仍可用）。

  Config:
    { "轨迹约束": { "roles": {
        "qa": {
          "model": "provider/model",
          "msms": ["web-search", "vlm-describe"],
          "tools": ["read", "grep", "glob"],
          "systemPromptFile": ".opencode/skiff/qa.md"
        } } } }

── 6. cognitive_trajectory（轨迹 + 唤醒注册表，D58）──
CCC 的一条 cognitive trajectory = 持久身体（SESSION.md）+ 时间轴（AGENT_SESSIONS/ 目录 + 唤醒注册表）。
一个 CCC 内可多条并行；条目全部由人类/agent 显式登记。
⚠️ ACC 不再提供**周期自唤醒**（原 autopilot，2026-09-15 整段退场：机制/时钟/container_admin autopilot
域/面板区块一并删除）。自主巡航改由 CCC 自己驱动（home-serenity 侧 msm autopilot-round 每轮自排下一轮，
真相源 = S151 SESSION.md §1/§1b/§1c）。**本轮的 cognitiveTrajectory.autopilot 配置段保留**（见下表）——
它现由 **CCC 侧脚本**读取，ACC 不再消费该段。
唤醒注册表（cognitive_trajectory send-later）：唤醒 = 未来时刻 + 一条 message，可唤醒自己或别的 cognitive trajectory；
落点 AGENT_SESSIONS/wake-registry.json，中心调度器到点投递（fire-and-forget；无回执、无回收）。
运行态诊断（ACC 负责人专用）：acc-diag（① live 运行态 / ①b 唤醒时钟 / ③ 唤醒注册表）。

▸ cognitiveTrajectory.skills（v1.44.0，**CCC 级 skill 供给**；owner 令 2026-09-20「要求实现我的诉求……
  注入是动态注入就行；create 先不触发吧；**轨迹约束也支持**」）：
  **本 CCC 的每条轨迹都带这些 skill**——声明的 skill 全文在该轨迹**被绑定期间**注入系统提示词
  （**动态注入**：每请求重新求值、不缓存 ⇒ 改配置或改 frontmatter **即时生效**，无需重新 use、无需重启）。
  两条声明来源**并集**（不是二选一）：本键 **cognitiveTrajectory.skills**（容器给的底座，**在前**）
  ＋ 轨迹自己 SESSION.md 顶部 frontmatter 的 skills:（这条轨迹额外的，**追加**；同名去重）。
  ✅ **含 轨迹约束角色会话**（旁路的是 ACC 身份与纪律；skill 是"工作资料"，照给）。
  守卫：名字先过安全校验才用于拼路径（防穿越）｜**合并后**统一 32 KB 上限截断｜找不到响亮写 [缺失]。
  ⚠️ 与 create **无关**（create 刻意不夺绑定，U6）⇒ 注入的门是"**存在绑定**"（cognitive_trajectory use）。
  失败语义：未配置 / 字段缺失 / 配置损坏 ⇒ **空数组**（= 无 CCC 级供给；轨迹级声明照旧生效）。
  归属（D23）：**机制在 ACC**（读取 + 合并 + 注入 + 守卫），**声明在 CCC**（本键）。

  Config:
    { "cognitiveTrajectory": {
        "skills": ["acc-session", "cce"],   // v1.44.0：本 CCC 的每条轨迹都带（含 轨迹约束会话）
        "autopilot": {                   // 原 autopilotTrajectory 段，字段不变（旧键仍回退读）
          "enabled": true,
          "intervalHours": 2,
          "session": "S151",
          "biasProvider": "autopilot-bias.ts",
          "topPrompt": "本轨迹核心目标/纪律/质量要求（CCC 自填，防漂移）",
          "avoidWakeHours": { "start": 8, "end": 18 }
        } } }

── 7. weixin（微信桥 F4c-3，含消息记录 hook）──
CCC 级微信个人号接入（iLink 协议）：dsh 一进程多 CCC，每 CCC 独立对接微信桥。
账号/路由/开关在此文件；**bot_token 凭据在 CCC localstore credential scope**
（扫码绑定后自动写入，永不进 git 明文面）。
路由 user → role：exact 优先，* 通配兜底；role 必须 ∈ 该 CCC 轨迹约束.roles。
面板（WebUI 设置 → 微信桥）可扫码绑定/移除账号/编辑路由；msm("weixin-doctor", ["status"|"diag"|"verify"|"guide"]) 排查 + 大而全指南。凭据主动查看：localstore get WEIXIN_<ACCOUNT>_TOKEN。
  ▸ 主动发送（v1.31.0：**ACC 工具 im-bridge**）：调
    im-bridge({channel:"weixin", action:"send", user:"<别名|id>", text:"<文本>"}) 给用户发消息——
    **工具只能操作本会话 CCC**（无 ccc 参数，防误发他容器）→ weixin-bridge.sendProactiveText →
    成功后触发 outgoing hook（source="proactive"）。文件用 action:"send-file" + file:"<CCC 内路径>"
    （逃逸/缺失/超 20MB 拒绝）+ 可选 caption。**可见性**：本 CCC 配置了 IM 通道
    （weixin.enabled=true）才出现在模型工具清单里；未配置 → 由 guards 逐 agent
    tools.restrict({deny:['im-bridge']}) 移除（不是"看得到但被拒"）。轨迹约束角色另需在
    roles.<role>.tools 白名单列出 im-bridge。
    历史（v1.30.9~v1.30.x）：CCC 侧 MSM weixin-send（走 loopback HTTP 入口 3082）——
    v1.31.0 已退役（脚本删除 + 注册表注销）；3082 入口保留给**非 agent 调用者**。

  ▸ 🔴🔴 **出站只有一条路：agent 自己调 im-bridge**（2026-10-24 起，owner 令）。
    桥**永不**替你回发最终文本 —— 你说什么、说几条、什么时候说、要不要不说，全由你决定。
    ⛔ 不要指望"我把话写进回答里就会自动发出去"：**不会**。必须真的调工具。
    ⇒ 每轮用户消息末尾都会附一行**已填好参数**的 im-bridge 调用模板（机制标记
    [serenity:weixin-manual-output]），照它改 text 即可。
    ⇒ 本轮结束仍未成功调用（send / send-file）→ 你会被打回（≤2 次，提示 = 标记 + 事实）；
      达上限后**用户将收不到任何消息**（没有任何兜底转发）。
    ⇒ 成功调用才算送达；失败调用不算（不会被当成本轮已发送）。
    ⚠️ **前提**：本轨迹必须在 \`.opencode/serenity.json\` 的 \`im.routes\` 里被点名，否则 \`im-bridge\`
      对你不**可见**——那种情况下闸门不会打回你（改成一条响亮告警，指明"该轨迹无发送权"），
      因为打回一个你根本满足不了的要求只会空转。

  ▸ **已退役（不要再配，配了也不生效）**：
    · \`weixin.autoReplyWithLastMessage\`（v1.30.10~2026-10-24）= 桥替 agent 回发最终文本。
      **被否理由**（owner 原话）：「autoReply 并不合适，主动性的 imBridge 仍然是更好的」——
      它让 agent 失去"说几条/何时说/要不要不说"的决定权，而那正是主动发送的价值。
    · \`weixin.fallbackOnNoSend\`（v1.30.17~2026-10-24）= 手动模式下 agent 没发成功时桥兜底转发。
      它只在上面那个开关 =false 时才有意义 ⇒ 一起退役。
    ⚠️ 旧配置里残留这两个键**静默忽略**（不会报错，也不会生效）。

  Config:
    { "weixin": {
        "enabled": true,
        "hook": "scripts/weixin-message-hook.ts",
        "accounts": [{ "accountId": "wechat-1", "name": "家庭助手", "enabled": true }],
        "routes": [{ "user": "*", "role": "my-role" }]
      } }

  ▸ weixin.hook（消息记录 hook，v1.27.13）：
  微信桥每收/发一条消息触发一次 CCC 自写脚本，由 CCC 自行持久化保存（存哪/存成什么
  /是否入库全归 CCC——ACC 不绑定存储）。未配置 hook → 零变化（不触发）。

  触发（双向）：
    incoming  = 用户 → bot：路由命中后、媒体落盘后触发（文本含语音转写；媒体带落盘 relPath）
    outgoing  = bot → 用户：发送成功后触发（reply = 用户实际收到的纯文本，已剥离 think）
      · source="proactive" = agent 经 im-bridge 主动发起（**2026-10-24 起这是唯一值**）
      · 历史值 reply / reply-fallback（桥自动回发 / 桥兜底转发）已随两个开关一起退役；
        存量日志里仍能看到它们，那是历史事实，不是当前行为
      · file（仅 send-file 补记）：{ "name": "报告.pdf", "size": 12345, "caption": "可选" }

  脚本约定（事件 JSON 单行经 stdin 传入；bun 优先 node 兜底）：
    #!/usr/bin/env bun  或  node script.js —— 读 process.stdin 整段 JSON.parse
    const ev = JSON.parse(await new Response(process.stdin).text())
    ev.event === 'incoming' | 'outgoing'

  事件 schema（**不含任何会话凭据**——context_token/bot_token/token/aes_key 均不出现）：
    { "event": "incoming", "ts": 1788359941488, "cccRoot": "/path/ccc",
      "accountId": "wechat-1", "userId": "u1@im.wechat",
      "sessionId": "skiff-weixin-xxx", "role": "my-role",
      "message": { "text": "你好", "media": [{ "kind": "image", "relPath": "_tmp/weixin-inbound/<hash>/img_x.jpg" }] } }
    { "event": "outgoing", "ts": ..., "cccRoot": ..., "accountId": ...,
      "userId": ..., "sessionId": ..., "role": ...,
      "reply": "已记录（纯文本）", "source": "proactive" }

  示例脚本（追加到按日文件——持久化归 CCC 自选：文件/DB/远端均可）：
    const fs = require('node:fs'); const p = '/path/ccc/AGENT_SESSIONS/_weixin-log.jsonl';
    fs.appendFileSync(p, JSON.stringify(ev) + '\\n');

  执行语义（旁路容忍）：异步 fire-and-forget + 15s 超时 kill + 失败仅日志——
  微信桥消息处理/回复不受 hook 影响；脚本须在 CCC 根内（路径逃逸拒绝）。
  媒体 relPath 指向 _tmp/weixin-inbound/（临时目录）——需持久保存媒体文件请自行 copy。

── 8. （已删除）exclusiveTools（专属工具声明，v1.33 → v1.106.0 删除）──
🔴 **本键已不存在**（owner 2026-11-01 裁「机制整体删」）。
原语义：ACC 注册但默认对所有 CCC 隐藏的工具，只有在 CCC 配置里点名才可见（fail-closed）。
**删除理由**：那张表永远只有一个成员 acc-diag，而它已并入**常驻**的 dashboard 的 diag 动作。
表空之后那个 filter 恒回空数组 ⇒ 机制**静默空转、且任何测试都证伪不了它**
（一个验不出死活的机制比没有它更坏：它提供"这里还有一层保护"的错觉）。

  ▸ 要运行态诊断 ⇒ 直接用 dashboard 的 diag 动作（**无需任何声明，所有轨迹可见**）。
  ▸ 旧配置里残留 exclusiveTools ⇒ **静默忽略**（schemastery 非 strict），不影响加载。
  ▸ ⚠️ 连带后果（owner 已知并确认）：dashboard 是常驻工具 ⇒ diag 段对**所有轨迹**可见，
    而它的 live 会话清单是**全部 CCC** 的（跨容器）。这是「方案 C」的既定代价，不是缺陷。
`


interface MsmFlag {
  name: string
  type?: string
  description?: string
  required?: boolean
  default?: unknown
}

export interface MsmEntry {
  name: string
  path: string
  skill?: string
  category?: string
  description?: string
  usage?: string
  flags?: MsmFlag[]
}

/** 🔴 2026-09-25（S142 第 1 批）：本接口**必须导出** —— `runMsm`/`runMsmAsync` 的**公开签名**引用它
 *  （此前未导出 ⇒ 外部调用方看不到该类型，只能传结构等价字面量 = 契约不完整）。 */
export interface MsmArgs {
  action: MsmAction
  name?: string
  args?: string[]
  skill?: string
  path?: string
  category?: string
  description?: string
  /** register: flags JSON 字符串（对齐 osp --flags 入参；如 '[{"name":"hook","type":"string",...}]'） */
  flags?: string
  /** register: 自定义 usage（缺省 'msm <name> [args...]'） */
  usage?: string
}

function parseRegistry(raw: string): MsmEntry[] {
  // BOM 剥离（Windows 审计问题 16）：带 \uFEFF 的注册表 JSON 解析失败
  const data = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
  if (Array.isArray(data)) return data as MsmEntry[]
  const entries = (data as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error('invalid registry: missing entries[]')
  return entries as MsmEntry[]
}

/**
 * 注册表单级化（需求⑤a S142 用户拍板：注册表只有一级——对齐 osp cccName 单聚合档）：
 * 所有 entry 集中写入 `.opencode/skills/<cccName>/references/mech-registry.json`
 * （cccName = .serenity 首行，即顶层入口 skill 目录），skill 只作 entry 字段。
 * 不再扫描/写入各 skill 目录的分散注册表（历史形态 v1.14~v1.27，register --skill
 * 曾写入各自 skill 目录 —— 多真相源，废弃）。
 */
function findRegistries(root: string): string[] {
  const cccName = readCccName(root)
  if (!cccName) return []
  const aggregate = join(root, '.opencode', 'skills', cccName, 'references', 'mech-registry.json')
  return existsSync(aggregate) ? [aggregate] : []
}

export function loadMsmEntries(root: string): MsmEntry[] {
  const byName = new Map<string, MsmEntry>()
  for (const regPath of findRegistries(root)) {
    for (const entry of parseRegistry(readFileSync(regPath, 'utf-8'))) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry)
    }
  }
  return [...byName.values()]
}

export function findEntry(root: string, name: string): MsmEntry | null {
  return loadMsmEntries(root).find((e) => e.name === name) ?? null
}

/**
 * 扫描各 skill `scripts/` 下的**未注册候选**（DC-M3 正向基准，对齐 osp）。
 *
 * 🔴 **入口判据**（S151 轮 112 跨轨迹信号 → S142 实测精化，2026-09-17；取证见 S142 §0q）：
 *   · **入口 ⟺ 有 shebang（`^#!`） ∨ 声明了 `function main(`** —— **`process.argv` 单独不算**。
 *     反例（实测）：`home-desk/scripts/lib/desk-dispatch.ts` 含 **5** 处 `process.argv`，
 *     但无 shebang / 无 `main()`，且被 `desk-window.ts`、`desk-vision.ts` **import** ⇒ **它是库**。
 *   · **库 ⟺ 无 shebang ∧ 无 `main()` ∧ 被其它脚本 import** ⇒ **不是 MSM 候选，不上报**。
 *     ⚠️ **"有 `.test.ts`" 不是入口证据** —— 库**同样**有测试
 *     （`home-serenity/scripts/dev-kit/dev-kit.test.ts` 开头自述"**共享库单测**"）。
 *     📌 实现只测**前两条**（shebang / `main()`）：第三条"被 import"是**描述性**的，不作判据 ——
 *     因为**无 CLI 入口的文件本来就不可能被 `msm()` 调用**，上报它只会得到一条无法处置的欠账。
 *     🔗 **与 DC-M2 自洽**：DC-M2 本就要求**已注册**脚本必须有 main() 守卫 ⇒ 把"无入口"的文件
 *     排除出候选，与注册表的契约**同向**（两条判据不会互相打架）。
 *
 * 🔴 **本函数只扫 `scripts/` 一层（非递归），这是当前刻意的语义**（嵌套子域对容器不可见；
 *   见 CCC `docs/t024-msm-skill-inventory.md` §3b）。**若将来改为递归，上面的判据就是护栏**：
 *   嵌套候选实测 **8 个**（`dev-kit/` 5 + `home-desk/scripts/lib/` 3）**全部是库**——
 *   不按判据过滤，一次递归就会制造 8 条假欠账，并可能诱使后续轮次把库注册成**假 MSM**。
 *   ⇒ **改递归前先读本条注释。**
 */
function scanSkillScripts(root: string): string[] {
  const out: string[] = []
  const skillsDir = join(root, '.opencode', 'skills')
  if (!existsSync(skillsDir)) return out
  for (const skill of readdirSync(skillsDir)) {
    const scriptsDir = join(skillsDir, skill, 'scripts')
    if (!existsSync(scriptsDir)) continue
    for (const f of readdirSync(scriptsDir)) {
      const abs = join(scriptsDir, f)
      // 目录**显式**排除：原先只是"靠目录名不以 .ts/.js/.mjs 结尾"碰巧被扩展名判据放过——
      // 不要把正确性建立在巧合上（一个名为 `foo.ts/` 的目录就会把它变成误报）。
      let isFile = false
      try {
        isFile = statSync(abs).isFile()
      } catch {
        continue // 悬空符号链接 / 竞态 ⇒ 不是可判定的脚本文件
      }
      if (!isFile) continue
      if (!/\.(ts|js|mjs)$/.test(f)) continue
      if (/\.(test|spec)\./.test(f)) continue // 测试文件不是 MSM 候选
      if (!hasCliEntry(abs)) continue // 库模块不是 MSM 候选（DC-M3 只报"未注册的**入口**"）
      out.push(join('.opencode', 'skills', skill, 'scripts', f))
    }
  }
  return out.sort()
}

/** 入口判据的机械实现（判据、反例与递归化护栏见 `scanSkillScripts` 注释） */
function hasCliEntry(absPath: string): boolean {
  let text: string
  try {
    text = readFileSync(absPath, 'utf-8')
  } catch {
    // 读不出来 ⇒ **按入口上报**（不静默放过）：M3 的职责是"别漏候选"，
    // 且"扫到却读不了"本身也是值得被看见的信号。
    return true
  }
  if (/^#!/.test(text)) return true
  return /\b(?:async\s+)?function\s+main\s*\(/.test(text)
}

/**
 * 注册表写入路径（需求⑤a 单级化）：永远返回 cccName 聚合档。
 * skill 参数保留签名（兼容调用方）但只进 entry 字段，不决定写入位置。
 */
/**
 * 注册表质量契约报告（DC-M1~M4）。**类型别名而非 interface**：`runMsm` 的返回类型是 `JsonValue`，
 * 而 `interface` 不获得隐式索引签名（别名对象类型才有）——用别名可让本报告直接作为 `JsonValue` 返回，
 * 不必在 `case 'check'` 里加类型断言。
 */
export type RegistryQualityReport = {
  /** 被检查的注册表条目数 */
  checked: number
  issues: { name: string; check: string; detail: string }[]
}

/**
 * **把 issue 列表压成「按检查码分组的一行摘要」**（D237：成功/失败类调用的返回精简）。
 *
 * ## 为什么需要它（owner 2026-10-24 令）
 *
 * > 「tool 的返回内容会影响 Agent 注意力……对于返回成功失败类的调用，如果成功要大幅精简；
 * >   对于其它的调用，简练其结构，在确保信息有效的情况下降低大小」
 *
 * 实测症状（本仓真读数）：`container_admin msm check` 返回 **36 条 issue，每条一个三字段对象**，
 * 而其中 **M1 有 20 条、detail 逐字相同**（`no .test.ts / .spec.ts`）、**M3 有 16 条**（同样同 detail）。
 * ⇒ 同一句话重复 20 遍**不携带额外信息**，只吃掉注意力。
 *
 * ## 判据（照 D237 分档）
 *
 * - **有 issue（失败面）⇒ 不省略任何一条**：失败条目是唯一能改变下一步的东西（D186「出声必须指名哪一半」）。
 *   但可以**折叠结构**：同 `(check, detail)` 的条目合并成「一组 + 名字列表」，逐条信息一个字不丢。
 * - **零 issue（成功面）⇒ 只留一行结论 + 计数**：通过的条目对下一步零信息量。
 *
 * @param report 原始报告（逐条 issue）
 * @returns 压缩后的**面向 agent 的**结构（键名短、重复消除；entries 全保留只做分组）
 */
export function compactRegistryQuality(report: RegistryQualityReport): {
  checked: number
  /** 0 ⇒ 全部通过（此时 groups 为空，agent 只需读 checked） */
  issueCount: number
  /** 按 (check, detail) 分组；**每个名字都保留**，只去掉重复的 detail 字面量 */
  groups: { check: string; detail: string; count: number; names: string[] }[]
} {
  const byKey = new Map<string, { check: string; detail: string; names: string[] }>()
  for (const it of report.issues) {
    // 分组键 = 检查码 + detail（同因同码才是"同一条判据的一次重复"）
    const key = `${it.check}\u0000${it.detail}`
    const hit = byKey.get(key)
    if (hit) hit.names.push(it.name)
    else byKey.set(key, { check: it.check, detail: it.detail, names: [it.name] })
  }
  const groups = [...byKey.values()]
    // 组间排序：检查码升序、组内名字保持原序（稳定 ⇒ 同一份注册表每次输出一致，S↑）
    .sort((a, b) => (a.check === b.check ? b.names.length - a.names.length : a.check < b.check ? -1 : 1))
    .map((g) => ({ check: g.check, detail: g.detail, count: g.names.length, names: g.names }))
  return { checked: report.checked, issueCount: report.issues.length, groups }
}

/**
 * **注册表「质量契约」判据（DC-M1~M4）** —— 具名出口（C5 观察面归一，2026-09-15）。
 *
 * 此前这段判据**只存在于 `runMsm` 的 `case 'check'` 分支体内**（没有名字、无法从别处取用），
 * 于是 `dashboard health` 只能另写一份 **不同判据** 的结构检查（`checkRegistryHealth`）。
 * 抽成具名函数后，两条判据**各自有名字、各自可被取用、且仍然完全独立**——合并它们是错的：
 * 本判据的主语是**条目契约**（有没有测试 / main() 守卫 / 双向注册 / path 型 flag），
 * 结构判据的主语是**文件能否安全解析**。同一份注册表在两条判据下可以给出相反结论。
 *
 * 行为与抽取前**逐字一致**（`runMsm` 的 `check` 分支现只做 `return checkRegistryQuality(root)`）。
 */
export function checkRegistryQuality(root: string): RegistryQualityReport {
  const entries = loadMsmEntries(root)
  const issues: { name: string; check: string; detail: string }[] = []
  // DC-M3 正向：扫描 skills scripts/ 下未注册的脚本（对齐 osp 脚本驱动）
  // win32 路径形式统一（正斜杠 + 大小写）避免误报（审计问题 15）
  const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
  const registeredPaths = new Set(entries.map((e) => norm(e.path)))
  for (const scriptPath of scanSkillScripts(root)) {
    if (!registeredPaths.has(norm(scriptPath))) {
      issues.push({ name: scriptPath, check: 'M3', detail: 'script not registered in mech-registry' })
    }
  }
  for (const e of entries) {
    const script = join(root, e.path)
    const scriptExists = existsSync(script)
    // DC-M3 反向：注册表引用但脚本缺失
    if (!scriptExists) issues.push({ name: e.name, check: 'M3', detail: `script missing (${e.path})` })
    // DC-M1：有 .test.ts 或 .spec.ts（对齐 osp）
    const testFileTs = script.replace(/\.ts$/, '.test.ts')
    const testFileSpec = script.replace(/\.ts$/, '.spec.ts')
    if (!existsSync(testFileTs) && !existsSync(testFileSpec)) {
      issues.push({ name: e.name, check: 'M1', detail: 'no .test.ts / .spec.ts' })
    }
    // DC-M2：main() 守卫（function main( / isMain / require.main === / import.meta.url，对齐 osp 判定）
    if (scriptExists) {
      const src = readFileSync(script, 'utf-8')
      const hasGuard =
        /function main\(/.test(src) ||
        /\bisMain\b/.test(src) ||
        /require\.main\s*===/.test(src) ||
        /import\.meta\.url/.test(src)
      if (!hasGuard) issues.push({ name: e.name, check: 'M2', detail: 'no main() guard' })
    }
    // DC-M4：路径型 flag 必须标记 type:"path"（对齐 osp）
    for (const f of e.flags ?? []) {
      if ('name' in f && /path|file|dir/i.test(f.name) && f.type !== 'path') {
        issues.push({ name: e.name, check: 'M4', detail: `flag --${f.name} should be type:"path"` })
      }
    }
  }
  return { checked: entries.length, issues }
}

function registryPathFor(root: string, _skill?: string): string {
  const cccName = readCccName(root) ?? 'unknown'
  return join(root, '.opencode', 'skills', cccName, 'references', 'mech-registry.json')
}

function writeRegistry(path: string, entries: MsmEntry[], isV1Wrapped = true): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = isV1Wrapped
    ? JSON.stringify({ version: 1, description: 'MSM registry (managed by acc-msm / dsh-serenity-hooks)', entries }, null, 2) + '\n'
    : JSON.stringify(entries, null, 2) + '\n'
  writeFileSync(path, payload, 'utf-8')
}

export function runMsm(root: string, args: MsmArgs): JsonValue {
  switch (args.action) {
    case 'list': {
      const entries = loadMsmEntries(root)
      const cccName = readCccName(root) ?? 'unknown'
      const header = `(serenity-plugin v${ACC_VERSION}) CCC:${cccName} Root:${root}`
      if (entries.length === 0) return `${header}\n(no MSM registered)`
      const lines = entries.map((e) => {
        const base = `${e.name} | ${e.skill ?? '-'} | ${e.category ?? '-'} | ${e.description ?? ''}`
        if (e.flags && e.flags.length > 0) {
          const flags = e.flags.map((f) => `--${f.name} <${f.type ?? 'string'}>`).join(', ')
          return `${base} [flags: ${flags}]`
        }
        return base
      })
      return `${header}\n` + lines.join('\n')
    }

    case 'guide':
      return { guide: MSM_GUIDE }

    // 🔴 2026-10-19 v1.75.0：`catalog` **降为指针**（owner 裁 Q3）。
    //    正文唯一入口 = `container_admin config docs catalog`。
    //    ⚠️ 为什么不是删掉这个动作：`msm catalog` 这个名字写在 CCC 侧文档与提示词里
    //    （本仓多处引用），硬删会静默失效。⇒ 保留名字、只换返回内容。
    case 'catalog':
      return { catalog: docsPointer('catalog', 'ACC 能力目录') }

    case 'exec': {
      const { entry, businessArgs, fmtJson, hasHelp, protocol } = prepareExec(root, args)
      const p = protocolResult(protocol)
      if (p !== undefined) return p
      // bun 优先（可直跑 TS），npx shell 兜底；注入 SERENITY_* env（对齐 osp）。
      // Windows 修复：裸 'bun'/npx.cmd 不可被 CreateProcess spawn（ENOENT/EINVAL）——
      // 先探测真 bun.exe 绝对路径（零 shell、argv 保真），命中失败才走 npx via shell。
      const baseOpts: import('node:child_process').SpawnSyncOptionsWithStringEncoding = { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], env: buildMsmEnv(root) }
      const bunBin = bunExecutablePath()
      let r = bunBin
        ? spawnSync(bunBin, [entry.path, ...businessArgs], baseOpts)
        : { error: { code: 'ENOENT' } as NodeJS.ErrnoException, status: null, stdout: '', stderr: '', pid: 0, signal: null }
      if (r.error && isBunMissing(r.error as NodeJS.ErrnoException)) {
        r = spawnSync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { ...baseOpts, shell: platform === 'win32' })
      }
      return msmExecResult(entry.name, r.status ?? 2, r.stdout ?? '', r.stderr ?? '', fmtJson, hasHelp)
    }

    case 'register': {
      const name = args.name ?? ''
      const { skill, path, category, description } = args
      if (!name) throw new Error('register requires name')
      if (!path || !category || !description) throw new Error('register requires path/category/description')
      // 对齐 osp：path 必须根内 + 脚本必须存在
      const scriptAbs = resolve(root, path)
      if (classifyPath(scriptAbs, root) === 'outside') {
        throw new Error(`MSM register: path "${path}" escapes CCC root "${root}"`)
      }
      if (!existsSync(scriptAbs)) {
        throw new Error(`MSM script not found: "${path}"`)
      }
      // 对齐 osp：name 全局唯一（聚合所有注册表判重，与 loadMsmEntries 一致）
      if (loadMsmEntries(root).some((e) => e.name === name)) {
        throw new Error(`MSM already registered: "${name}"`)
      }
      const regPath = registryPathFor(root, skill)
      // 对齐 osp：保留原注册表格式（数组 vs v1 wrapper）；剥 BOM 防 Windows 编辑器 \uFEFF（审计#13）
      // P3-③ review：**首建统一 v1 wrapper**——文件不存在（raw===''）时旧逻辑 isV1Wrapped=false
      // → 裸数组，与 writeRegistry 默认 v1 wrapper 并存（格式分裂）。首建一律 v1 wrapper。
      const raw = existsSync(regPath) ? readFileSync(regPath, 'utf-8').replace(/^\uFEFF/, '') : ''
      const isV1Wrapped = raw === '' ? true : !Array.isArray(JSON.parse(raw))
      const entries = existsSync(regPath) ? parseRegistry(readFileSync(regPath, 'utf-8')) : []
      // flags/usage 入参（对齐 osp：可选，缺省空数组 / 自描述 usage）
      let flags: MsmFlag[] | undefined
      if (args.flags) {
        try {
          const parsed = JSON.parse(args.flags) as unknown
          if (!Array.isArray(parsed)) throw new Error('flags must be a JSON array')
          flags = parsed as MsmFlag[]
        } catch (e) {
          throw new Error(`register flags parse failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      entries.push({
        name, path, skill, category, description,
        usage: args.usage ?? `msm ${name} [args...]`,
        flags: flags ?? [],
      })
      writeRegistry(regPath, entries, isV1Wrapped)
      try {
        // 对齐 osp：精提交（只 add 注册表文件，非 add -A）
        const relRegistry = relative(root, regPath)
        execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
        execFileSync('git', ['commit', '-m', `chore(msm): register ${name}`], { cwd: root, stdio: 'pipe' })
      } catch {
        /* 非 git 环境忽略 */
      }
      return { registered: name, registry: relative(root, regPath) }
    }

    case 'deregister': {
      const name = args.name ?? ''
      for (const regPath of findRegistries(root)) {
        // 剥 BOM 防 Windows 编辑器 \uFEFF（审计#13，与 parseRegistry 一致）
        const dRaw = readFileSync(regPath, 'utf-8').replace(/^\uFEFF/, '')
        const isV1Wrapped = !Array.isArray(JSON.parse(dRaw))
        const entries = parseRegistry(readFileSync(regPath, 'utf-8'))
        const idx = entries.findIndex((e) => e.name === name)
        if (idx >= 0) {
          entries.splice(idx, 1)
          writeRegistry(regPath, entries, isV1Wrapped)
          try {
            const relRegistry = relative(root, regPath)
            execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
            execFileSync('git', ['commit', '-m', `chore(msm): deregister ${name}`], { cwd: root, stdio: 'pipe' })
          } catch {
            /* 忽略 */
          }
          return { deregistered: name }
        }
      }
      throw new Error(`MSM not registered: "${name}"`)
    }

    // 🔴 2026-10-19 v1.75.0：`ccc-config` **降为指针**，同 `catalog`（owner 裁 Q3）。
    case 'ccc-config':
      return docsPointer('config', 'CCC 配置参考')

    case 'check': {
      // C5（2026-09-15）：判据实现抽成具名导出 `checkRegistryQuality`（供 container-status
      // 的注册表分组取用）。行为逐字不变——本分支曾内联这段逻辑且**无名字**。
      //
      // 🔴 D237（2026-10-24 owner 令）：**工具返回面**改为压缩形态 —— 同 (check,detail) 的重复
      // 条目合并成一组（每个 name 仍逐条保留，只去掉重复的 detail 字面量）。
      // ⚠️ **只改返回面，不改 `checkRegistryQuality` 本身**：它有 5 处消费者
      //    （`surface/observation.ts` 的 quality 段 ＋ 4 个测试文件），改它的形状 = 换真相源形状。
      //    压缩是**渲染层**的事（E↑：数据保真、展示精简）。
      return compactRegistryQuality(checkRegistryQuality(root))
    }

    default:
      throw new Error(`Unknown action: ${args.action as string}`)
  }
}

/** 解析并校验 exec 参数：返回可执行条目 + 业务参数（list/schema 协议 flag 已分流） */
interface PreparedExec {
  entry: MsmEntry
  businessArgs: string[]
  fmtJson: boolean
  /** 业务参数是否含 --help/-h（exit≠0 时不追加 TIP，对齐 osp） */
  hasHelp: boolean
  /** 协议结果（--list / --schema）；非协议执行时为 undefined */
  protocol?: { list: { name: string; category: string | null }[] } | { schema: { name: string; path: string; flags: { name: string; type: string | null; description: string | null }[] } }
}

function prepareExec(root: string, args: MsmArgs): PreparedExec {
  const name = args.name ?? ''
  const entry = findEntry(root, name)
  if (!entry) throw new Error(`MSM not registered: "${name}"`)
  const business = args.args ?? []

  // 协议 flag：仅在业务参数**首位**识别（--list / --schema <name> / --format=json）——
  // 业务参数中后置的同名 flag 一律无损透传（对齐 osp 无损透传承诺，避免误拦截）
  if (business[0] === '--list') {
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      hasHelp: false,
      protocol: { list: loadMsmEntries(root).map((e) => ({ name: e.name, category: e.category ?? null })) },
    }
  }
  if (business[0] === '--schema') {
    const target = business[1]
    const found = target ? loadMsmEntries(root).find((e) => e.name === target) : null
    if (!found) throw new Error(`MSM not registered: "${target}"`)
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      hasHelp: false,
      protocol: { schema: { name: found.name, path: found.path, flags: (found.flags ?? []).map((f) => ({ name: f.name, type: f.type ?? null, description: f.description ?? null })) } },
    }
  }
  const fmtJson = business[0] === '--format=json'
  const businessArgs = fmtJson ? business.slice(1) : business
  const hasHelp = businessArgs.includes('--help') || businessArgs.includes('-h')

  // path-arg 逃逸校验（ACC 标准，对齐 osp）：flags 中 type:"path" 的参数值必须根内 + symlink 防御
  for (const flag of entry.flags ?? []) {
    if (flag.type !== 'path') continue
    const eq = businessArgs.find((a) => a.startsWith(`--${flag.name}=`))
    if (eq) {
      assertPathInsideRoot(root, eq.slice(flag.name.length + 3), flag.name)
    } else {
      const idx = businessArgs.indexOf(`--${flag.name}`)
      if (idx >= 0 && businessArgs[idx + 1]) {
        assertPathInsideRoot(root, businessArgs[idx + 1]!, flag.name)
      }
    }
  }

  const script = resolve(root, entry.path)
  if (classifyPath(script, root) === 'outside') throw new Error(`MSM script escapes CCC root: "${entry.path}"`)
  if (!existsSync(script)) throw new Error(`MSM script not found: "${entry.path}"`)
  return { entry: { ...entry, path: script }, businessArgs, fmtJson, hasHelp }
}

/** 协议结果扁平化：{list|schema} 包装 → 顶层值（兼容旧契约）；非协议返回 undefined */
function protocolResult(protocol: PreparedExec['protocol']): JsonValue | undefined {
  if (!protocol) return undefined
  if ('list' in protocol) return protocol.list as unknown as JsonValue
  if ('schema' in protocol) return protocol.schema as unknown as JsonValue
  return undefined
}

/** 失败 TIP（对齐 osp：业务 exit≠0 且未传 --help 时追加提示） */
function helpTip(): string {
  return '\n[TIP] Pass "--help" as the first arg to see this MSM\'s usage and required flags.'
}

function msmExecResult(name: string, status: number, stdout: string, stderr: string, fmtJson: boolean, hasHelp = false): JsonValue {
  const tip = status !== 0 && !hasHelp ? helpTip() : ''
  if (fmtJson) {
    return status === 0
      ? { name, exit: 0, ok: true, data: stdout.trim() }
      : { name, exit: status, ok: false, error: (stderr.trim() || stdout.trim()) + tip }
  }
  return { name, exit: status, stdout, stderr: stderr + tip }
}

/**
 * 异步执行 MSM（msm 工具主路径）：
 * 用 execFile + promisify + timeout（超时自动 kill），**不阻塞 Node 事件循环**。
 * （同步 spawnSync 版会阻塞 web 事件循环 → MSM 脚本自请求 3080 时死锁，见 postmortem。）
 */

/** bun 缺失的错误码集（Windows 兼容：无 bun 时 execFile('bun') 抛 EINVAL 而非 ENOENT，见 Windows 审计问题 5） */
const BUN_MISSING_CODES = new Set(['ENOENT', 'EINVAL', 'EPERM'])

function isBunMissing(err: NodeJS.ErrnoException): boolean {
  return typeof err.code === 'string' && BUN_MISSING_CODES.has(err.code)
}

export async function runMsmAsync(root: string, args: MsmArgs): Promise<JsonValue> {
  if (args.action !== 'exec') return runMsm(root, args)
  const { entry, businessArgs, fmtJson, hasHelp, protocol } = prepareExec(root, args)
  const p = protocolResult(protocol)
  if (p !== undefined) return p
  // bun 优先（可直跑 TS），npx shell 兜底；注入 SERENITY_* env（对齐 osp）。
  // Windows 修复（审计问题 5）：探测真 bun.exe 绝对路径（零 shell），避免裸 'bun' ENOENT 与 npx.cmd EINVAL。
  const bunBin = bunExecutablePath()
  const baseOpts = {
    cwd: root,
    encoding: 'utf-8' as const,
    timeout: MSM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: buildMsmEnv(root),
  }
  try {
    if (bunBin) {
      const r = await execFileAsync(bunBin, [entry.path, ...businessArgs], baseOpts)
      return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson, hasHelp)
    }
    // 无 bun：直接走 npx shell 兜底
    throw { code: 'ENOENT' } as NodeJS.ErrnoException
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
    if (isBunMissing(err)) {
      try {
        const r = await execFileAsync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { ...baseOpts, shell: platform === 'win32' })
        return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson, hasHelp)
      } catch (e2) {
        const err2 = e2 as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
        const status = err2.killed ? 124 : (typeof err2.code === 'number' ? err2.code : 2)
        const stdout = err2.stdout ?? ''
        const stderr = err2.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err2.stderr ?? err2.message ?? '')
        return msmExecResult(entry.name, status, stdout, stderr, fmtJson, hasHelp)
      }
    }
    const status = err.killed ? 124 : (typeof err.code === 'number' ? err.code : 2)
    const stdout = err.stdout ?? ''
    const stderr = err.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err.stderr ?? err.message ?? '')
    return msmExecResult(entry.name, status, stdout, stderr, fmtJson, hasHelp)
  }
}
