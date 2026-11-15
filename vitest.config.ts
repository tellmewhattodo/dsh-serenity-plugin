import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 🔴 2026-09-28：`tests/**`（仓库根）已随**安装器族**整体退役（S142 ③ 周边整合）——
    // 那 9 个用例钉的是安装器 CLI 与技能模板，随 `src/`／`bin/` 一起删。
    // 本仓现在的测试面 = hooks 包 + 开发脚本。
    include: ['hooks/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    // v1.30.16：`.pnpm-store` 在 hooks 目录内（.npmrc 的 store-dir，gitignore 但**在文件树里**），
    // 其中的 side-effects/projects 缓存会带一份项目文件副本 → `hooks/**/tests/**` 会把它当测试收集，
    // 同一测试跑两遍（实证：固定端口 3182 EADDRINUSE 假失败）。显式排除（含 vitest 默认项，避免覆盖丢失）。
    exclude: ['**/node_modules/**', '**/.pnpm-store/**', '**/dist/**', '**/coverage/**', '**/.git/**'],
    environment: 'node',
    // 🔴 2026-11-16（真机红转绿后追的根因）：vite 的默认 `cacheDir` 是 `node_modules/.vite`，
    //    而它按**进程 cwd 的上级链**解析。`dsh-develop coverage` 从 `hooks/` 跑，
    //    缓存曾落到 **CCC 的 `.opencode/skills/node_modules/.vite`** —— 那个位置会被
    //    `serenity-skills-ontology.ttl` 的 `forall s in Skill: skillDependsOn(s, HomeSerenity)
    //    implies s.hasSkillMd == true` 当成一个 skill（缺 SKILL.md ⇒ 合规用例红）。
    //    ⇒ 症状（本体合规红）与真因（测试缓存在别人家门口）**完全不像**，故钉死在这里。
    cacheDir: 'node_modules/.vite',
    // coverage 见 hooks/dsh-serenity-hooks/vitest.config.ts（dsh-develop coverage 从 hooks 目录运行——
    // coverage-v8 装在 hooks node_modules；本根配置普通 test 不需要 coverage 依赖）
  },
});
