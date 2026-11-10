/**
 * browser/home.ts — 槽位体系的**全局**家目录（跨 CCC 唯一）
 *
 * 🔴🔴 **这个文件修的是一个根本性缺陷**（owner 2026-11-10 指出）：
 *
 *    原实现把台账放在 `<CCC 根>/.opencode/browser-slots.json`，**每个 CCC 各一份**。
 *    而端口 `9301..9320` 是**全机唯一资源**，Chrome 进程也是**全机唯一**的。
 *    ⇒ 同一台机器上跑两个 CCC 时：
 *        · CCC-A 读自己的台账 ⇒ 认为 b1 空闲 ⇒ 起在 9301
 *        · CCC-B 读自己的台账 ⇒ **也**认为 b1 空闲 ⇒ **也想在 9301**
 *    而 `portHolders` 只能事后发现端口被占，**无法阻止两个 CCC 同时决定用同一个槽**。
 *
 *    判据（这条比修法值钱）：**资源的唯一性必须由"状态载体的唯一性"保证**，
 *    ⛔ 不能靠"每个使用者各自记一份、然后指望它们对得上"。
 *    —— 2026-11-09 那次「槽位租到了却没人能操作」是**同一族**的另一个形态：
 *       两处各记一份端口表，于是必然漂。那次漂在**端口区间**，这次漂在**归属**。
 *
 * ## 落点
 *
 *   `~/.dsh/serenity-browser-slots/`         ← 默认（宿主存储家，天然跨 CCC）
 *     ledger.json                            唯一台账
 *     b1/{user-data,identity.json,shots,chrome.log}
 *
 * 🔴 **为什么不放某个 CCC 里**：放谁家就等于让那个 CCC 当"主"，
 *    其余 CCC 的权力关系会隐式绑定到目录归属上 —— 那是治理问题，不是技术问题。
 *    放宿主家 = 中立，且随宿主（而不是随某个 CCC 的 git）存活。
 *
 * 🔴 **为什么 profile 也必须是全局的**（不只台账）：
 *    槽位 b1 今天给 CCC-A、明天给 CCC-B。若 profile 跟着 CCC 走，
 *    那"b1 的登录态"就会有两份，而**两份登录态在读数上无法区分** ——
 *    你会以为自己登着，其实是另一个 profile。⇒ 一个槽位**只有一份** profile。
 *
 * ⚠️ 覆盖：`SERENITY_BROWSER_SLOTS_DIR`（测试用；也便于把它挪到别的盘）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 环境变量名（覆盖全局家目录） */
export const SLOTS_DIR_ENV = 'SERENITY_BROWSER_SLOTS_DIR'

/** 判「此刻是不是在测试进程里」的环境标记（vitest 自己会设 `VITEST`） */
const TEST_ENV_MARKERS = ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID'] as const

/**
 * 槽位体系的全局家目录。
 *
 * 判据：**不含任何 CCC 根** —— 这正是它跨 CCC 的唯一原因。
 * ⛔ 不要给它加一个 `cccRoot` 参数（那会立刻退回"每个 CCC 各一份"的原缺陷）。
 */
export function slotsHomeDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[SLOTS_DIR_ENV]
  if (override && override.trim() !== '') return override
  assertNotPollutingRealHome(env)
  return join(homedir(), '.dsh', 'serenity-browser-slots')
}

/**
 * 🔴🔴 **测试进程必须显式指定家目录，⛔ 不许静默落在真实家目录上**。
 *
 * 这条修的是一个**真的发生过**的污染（2026-11-10 真机实测）：
 *    全局化改动之后，一个**没跟着迁移**的旧测试仍在调 `writeLedger(root, …)` ——
 *    而全局化后的 `writeLedger(ledger)` 只有一个形参 ⇒ **多传的那个 `root` 被 JS 静默忽略**
 *    ⇒ 测试夹具 `{slot:2, pid:4242, sessionId:'sess-a'}` 落进了**真实的**全局台账
 *    ⇒ 之后 `reap b2` 的读数里出现了三条"占用者 sess-a"的幽灵租约，
 *       并且 `destroySlot` 拿着 `pid:4242` 去杀了**一个陌生进程**（详见 process.ts 的判据）。
 *
 * 危害的形状（值得单记）：**测试污染的是唯一真相源，而污染读数与真实读数完全同形** ——
 * 之后所有人（包括看守）都会把幽灵租约当成真的占用者。
 *
 * ⇒ 判据：**"多余的参数被忽略"是 JS 的默认行为，⛔ 不能指望调用方自己发现错签名**。
 *    唯一的机械保证是：测试进程**不给出覆盖值就起不来**。
 * ⚠️ 这条只挡"忘记覆盖"，⛔ 不挡"覆盖成一个也错的路径"（那属于测试自己的责任）。
 */
function assertNotPollutingRealHome(env: Record<string, string | undefined>): void {
  const inTest = TEST_ENV_MARKERS.some((k) => typeof env[k] === 'string' && env[k] !== '')
  if (!inTest) return
  throw new Error(
    `⛔ 测试进程里 ${SLOTS_DIR_ENV} 必须显式指向临时目录（当前未设置）。\n` +
      `  原因：槽位台账是**全局唯一真相源**，测试写进去会留下与真实占用**完全同形**的幽灵租约，` +
      `且之后 reap/destroy 会按那份脏台账去杀进程。\n` +
      `  ⇒ 在测试里这样写：process.env.${SLOTS_DIR_ENV} = mkdtempSync(join(tmpdir(), 'slot-…'))`,
  )
}
