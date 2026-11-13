/**
 * browser/coords.ts — 坐标参数的**纯解析**（`x,y` 字符串 ／ `[x,y]` 数组 ／ `{x,y}` 对象）。
 *
 * 🔴🔴 **为什么必须三种形态都收**（2026-11-13 真机事故，owner 截图）：
 *    坐标原本**只声明成 string**，于是模型想传两个数字时写出了「裸两个值」：
 *      {"xy": 1428,76}   ← 坏 JSON
 *    宿主在**参数 JSON 解析阶段**就拒了（`MALFORMED_RESPONSE`）⇒ **我们的工具一次都没执行**。
 *    表现是「本轮运行失败」，而根因**不在点击逻辑里** —— 是 schema 把一个自然的写法挤了出去。
 *
 *    ⇒ 判据：**schema 的形状会改变调用方的写法**。只收 string 等于强迫模型把两个数字
 *      序列化进一个字符串，而「数字就是数字」是它更自然的表达。三种都收，坏写法就失去动机。
 *
 * ⚠️ 但**收得宽 ≠ 判得松**：形态放宽了，「解析成功」的门槛一条没降 ——
 *    非有限数、负数、多于/少于两个分量，一律返回 null（调用方据此拒绝并列出正确形态）。
 */

/** 一个视口坐标 */
export interface XY {
  x: number;
  y: number;
}

/** 坐标的三种合法入参形态（schema 与解析器必须**同时**支持这三者） */
export type XYInput = string | readonly unknown[] | { x?: unknown; y?: unknown } | null | undefined;

/**
 * 解析坐标。
 *
 * 判据（每条都是「宁可拒绝」）：
 *   ① 只接受三种形态；其余（布尔、裸数字、对象缺分量）⇒ null
 *   ② 分量必须是**有限数**且 **≥ 0** —— 负数与 NaN 会让点击落到别处或直接被 CDP 丢弃
 *   ③ 字符串形态按 `,` 或空白切；**必须正好两个分量**（`"1,2,3"` 拒绝，⛔ 不取前两个）
 */
export function parseXY(raw: XYInput): XY | undefined {
  if (raw === null || raw === undefined) return undefined;

  let a: unknown;
  let b: unknown;

  if (typeof raw === 'string') {
    const parts = raw.split(/[,\s]+/).filter((s) => s !== '');
    if (parts.length !== 2) return undefined; // ③
    a = parts[0];
    b = parts[1];
  } else if (Array.isArray(raw)) {
    if (raw.length !== 2) return undefined;
    a = raw[0];
    b = raw[1];
  } else if (typeof raw === 'object') {
    const o = raw as { x?: unknown; y?: unknown };
    a = o.x;
    b = o.y;
    if (a === undefined || b === undefined) return undefined; // ①
  } else {
    return undefined; // ①
  }

  const x = typeof a === 'number' ? a : Number(a);
  const y = typeof b === 'number' ? b : Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined; // ②
  if (x < 0 || y < 0) return undefined; // ②
  return { x, y };
}

/** 拒绝时列给调用方的三种正确形态（⛔ 只列一种 —— 那等于又把口子收窄回去） */
export function xyFormHint(param = 'xy'): string {
  return [
    `  --${param}=1428,76        （字符串：逗号分隔）`,
    `  --${param}=[1428,76]      （数组：两个数字）`,
    `  --${param}={x:1428,y:76}  （对象）`,
  ].join('\n');
}
