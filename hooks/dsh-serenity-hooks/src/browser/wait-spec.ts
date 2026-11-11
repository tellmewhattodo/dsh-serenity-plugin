/**
 * browser/wait-spec.ts — `wait` 动作的**条件解析**（纯判定，可逐条单测）。
 *
 * 🔴 为什么把「人写的条件」和「页面里跑的 JS」分开：
 *    条件字符串要**拼进页面执行的 JS 源码**里。若直接把这串东西拼上去，
 *    一个带引号/反斜杠/换行的参数就能改掉整段程序（最轻的是语法错，最重的是执行别的东西）。
 *    ⇒ 本文件的产物是**一段由常量拼出的、不含调用方原文的 JS 片段**，
 *    所有调用方输入都经 `JSON.stringify` 变成**字面量**。
 *
 * 支持的形态（其余一律拒绝并列出可用形态，⛔ 不猜）：
 *   `selector:css`      选择器出现（`document.querySelector` 不为 null）
 *   `text:子串`         页面可见正文包含该子串
 *   `url:子串`          当前 URL 包含该子串
 *   `gone:css`          选择器**消失**（等加载遮罩消失用）
 *   `js:表达式`         自定义表达式，为 `true` 或 `{ok:true}` 时成立
 */

export type WaitKind = 'selector' | 'text' | 'url' | 'gone' | 'js'

export interface WaitSpec {
  kind: WaitKind
  /** 原始参数（已经剥掉前缀） */
  arg: string
  /** 要喂给页面执行的条件表达式（**不含调用方原文的裸拼接**） */
  expression: string
}

/** 可用形态的人话说明（拒绝时列给调用方） */
export const WAIT_FORMS = [
  'selector:<CSS 选择器>   元素出现',
  'text:<子串>             可见正文包含该子串',
  'url:<子串>              当前 URL 包含该子串',
  'gone:<CSS 选择器>       元素消失',
  'js:<表达式>             自定义表达式为真',
];

/**
 * 解析 `--for` 参数。
 *
 * 判据：
 *   ① 没有前缀的裸值 ⇒ **拒绝**（既有习惯是「给个选择器」，但裸值有歧义：
 *      它可能是选择器、可能是文本、也可能是 URL 片段 —— 猜错会等一个**永不到来**的条件，
 *      而超时只说「等到了头」，不告诉你是猜错了形态）
 *   ② `js:` 形态**照原样**拼（这是唯一接受任意代码的一档，且调用方已经明确要执行代码）
 *   ③ 其余形态的参数一律 `JSON.stringify` 成字面量，⛔ 不拼原文
 */
export function parseWaitSpec(raw: string): WaitSpec | null {
  const s = raw.trim();
  if (!s) return null;
  const i = s.indexOf(':');
  if (i <= 0) return null; // ①
  const kind = s.slice(0, i).toLowerCase();
  const arg = s.slice(i + 1);
  if (!arg) return null;

  if (kind === 'js') return { kind: 'js', arg, expression: '(' + arg + ')' }; // ②
  const lit = JSON.stringify(arg);
  if (kind === 'selector') {
    return {
      kind: 'selector',
      arg,
      expression: 'document.querySelector(' + lit + ') !== null',
    };
  }
  if (kind === 'gone') {
    return {
      kind: 'gone',
      arg,
      expression: 'document.querySelector(' + lit + ') === null',
    };
  }
  if (kind === 'text') {
    return {
      kind: 'text',
      arg,
      expression: '((document.body && document.body.innerText) || "").includes(' + lit + ')',
    };
  }
  if (kind === 'url') {
    return { kind: 'url', arg, expression: 'location.href.includes(' + lit + ')' };
  }
  return null;
}

/** 把超时结果翻成人话（含「等的是什么」与「最后一次读到什么」） */
export function explainWaitTimeout(spec: WaitSpec, waitedMs: number, last: unknown): string {
  const what =
    spec.kind === 'selector'
      ? '元素出现：' + spec.arg
      : spec.kind === 'gone'
        ? '元素消失：' + spec.arg
        : spec.kind === 'text'
          ? '正文包含「' + spec.arg + '」'
          : spec.kind === 'url'
            ? 'URL 包含「' + spec.arg + '」'
            : '表达式为真：' + spec.arg;
  const lastText =
    last === null || last === undefined
      ? '（什么都没读到）'
      : typeof last === 'string'
        ? last
        : JSON.stringify(last).slice(0, 200);
  return (
    '⛔ 等待超时（' + String(Math.round(waitedMs / 100) / 10) + 's）—— 等的是：' + what + '\n' +
    '  最后一次读数：' + lastText + '\n' +
      '  ⇒ 若最后一次读数是 null/false，多半是条件写错了（形态：' + spec.kind + '）；' +
    '若是别的值，说明条件在往别的方向走 —— 用 eval 看一眼实际状态再重试。'
  );
}
