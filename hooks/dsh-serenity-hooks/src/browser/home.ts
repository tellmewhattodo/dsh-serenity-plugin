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

/**
 * 槽位体系的全局家目录。
 *
 * 判据：**不含任何 CCC 根** —— 这正是它跨 CCC 的唯一原因。
 * ⛔ 不要给它加一个 `cccRoot` 参数（那会立刻退回"每个 CCC 各一份"的原缺陷）。
 */
export function slotsHomeDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[SLOTS_DIR_ENV]
  if (override && override.trim() !== '') return override
  return join(homedir(), '.dsh', 'serenity-browser-slots')
}
