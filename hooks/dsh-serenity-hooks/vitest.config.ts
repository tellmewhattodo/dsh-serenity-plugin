import { defineConfig } from 'vitest/config';

// hooks 子项目本地 vitest 配置——coverage 度量用（dsh-develop coverage 从本目录运行）。
// 普通 test 仍从仓库根运行（根 vitest.config.ts include 覆盖根 tests/ + hooks tests + scripts tests）。
// 本配置独立存在是因为 coverage-v8 装在 hooks 自身 node_modules（根 node_modules 无）——
// 根 vitest 解析不到 provider；coverage 目标 = hooks src（node 侧主产物），从 hooks 目录跑最直接。
//
// 🔴 **两个配置的扫描域不同，两个读数因此天然不等**（2026-11-04 M2 实测，登记以防误判）：
//   · `dsh-develop test`（根配置）  ⇒ 206 files / 3276 tests（**含 `scripts/` 的 2 文件 18 条**）
//   · `dsh-develop coverage`（本配置）⇒ 204 files / 3258 tests（只扫 hooks/tests）
//   ⇒ 差 **18 条、少 2 个文件**。谁看到这两个数不一样，**先想到扫描域，别想到"漏测"**。
//   ⚠️ 判据：本配置的 include 是 `tests/**`，只覆盖 hooks 自己的测试；`scripts/` 的测试
//     （`dsh-develop.test.ts`、`session-repair.test.ts`）**不进 coverage** —— 它们测的是开发工具，
//     不是 `src/` 的覆盖率对象，故这是**刻意的**，不是遗漏。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/kernel/invariant.ts',
        'src/kernel/constants.ts',
        'src/kernel/json.ts',
        'src/client/**',
        'src/**/*.d.ts',
      ],
      // 阈值（2026-09-05 首份基线：全仓 80.88/78.04/80.81/80.88——设 60 留补测空间同时防倒退；
      // 低洼模块 api 21/gateway 27/opencode-skills 31/tools 壳 50-60 逐批补测后收紧到 70+/80+）
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 55,
        lines: 60,
      },
    },
  },
});
