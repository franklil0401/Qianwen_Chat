import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { KnowledgeItem, ToolResult } from '../shared/types.ts';

export const toolDefinitions = [
  { type: 'function', function: { name: 'calculate', description: '计算普通数学表达式，使用 IEEE 754 双精度浮点数，小数结果可能近似，整数限制在安全整数范围。支持 + - * / % ^、括号、sqrt/abs/round/floor/ceil/min/max/pow 函数；百分数写成 /100，^ 表示乘方。round 按十进制四舍五入。涉及数值运算时优先使用。', parameters: { type: 'object', properties: { expression: { type: 'string', description: '数学表达式，例如 (128*36+259)/7 或 round(10/3,2)' } }, required: ['expression'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_knowledge', description: '检索项目自带的本地演示资料，涵盖流式输出、取消/打断、工具调用、架构、面试演示和上下文安全。不是联网搜索。返回真实命中条目；未命中时返回空数组。', parameters: { type: 'object', properties: { query: { type: 'string', description: '简洁的检索关键词或问题' }, limit: { type: 'integer', minimum: 1, maximum: 5, description: '最多返回条目数，默认3' } }, required: ['query'], additionalProperties: false } } },
] as const;

const calculatorSchema = z.object({ expression: z.string().trim().min(1).max(256) }).strict();
const searchSchema = z.object({ query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(5).default(3) }).strict();

/** Bounded recursive-descent parser: no eval, property access, or arbitrary calls. */
export function calculate(expression: string): number {
  if (expression.length > 256 || !expression.trim()) throw new Error('表达式需为 1–256 个字符');
  const tokens = expression.match(/\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[a-z]+|\*\*|[+\-*/%^(),]|\s+|./gi)?.filter(t => !/^\s+$/.test(t)) ?? [];
  if (tokens.length > 128) throw new Error('表达式过于复杂');
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const finite = (value: number) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error('结果超出支持范围，或包含除零/无效运算');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('数值超过安全整数范围，请使用专门的高精度计算工具');
    return value;
  };
  const shiftDecimal = (value: number, places: number) => {
    const [coefficient, exponent = '0'] = value.toString().split('e');
    return Number(`${coefficient}e${Number(exponent) + places}`);
  };
  const primary = (): number => {
    if (++depth > 32) throw new Error('括号嵌套过深');
    try {
      const token = consume();
      if (token === '(') { const value = sum(); if (consume() !== ')') throw new Error('括号不匹配'); return value; }
      if (token && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return finite(Number(token));
      if (token && /^(sqrt|abs|round|floor|ceil|min|max|pow)$/i.test(token)) {
        if (consume() !== '(') throw new Error('函数需使用括号');
        const args = [sum()];
        while (peek() === ',') { consume(); args.push(sum()); }
        if (consume() !== ')' || args.length > 10) throw new Error('函数参数不正确');
        const name = token.toLowerCase();
        const unary: Record<string, (value: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil };
        if (name in unary) { if (args.length !== 1) throw new Error('该函数需要一个参数'); return finite(unary[name](args[0])); }
        if (name === 'round') {
          if (args.length > 2 || (args.length === 2 && (!Number.isInteger(args[1]) || Math.abs(args[1]) > 12))) throw new Error('round 精度必须是 -12 到 12 的整数');
          const places = args[1] ?? 0;
          return finite(Math.sign(args[0]) * shiftDecimal(Math.round(shiftDecimal(Math.abs(args[0]), places)), -places));
        }
        if (name === 'pow') { if (args.length !== 2) throw new Error('pow 需要两个参数'); return finite(args[0] ** args[1]); }
        return finite(name === 'min' ? Math.min(...args) : Math.max(...args));
      }
      throw new Error('包含不支持的字符、函数或缺失操作数');
    } finally { depth--; }
  };
  const power = (): number => { const left = primary(); if (peek() === '^' || peek() === '**') { consume(); return finite(left ** unary()); } return left; };
  const unary = (): number => { if (peek() === '+') { consume(); return unary(); } if (peek() === '-') { consume(); return -unary(); } return power(); };
  const product = (): number => { let value = unary(); while (['*', '/', '%'].includes(peek())) { const op = consume(); const right = unary(); value = finite(op === '*' ? value * right : op === '/' ? value / right : value % right); } return value; };
  const sum = (): number => { let value = product(); while (peek() === '+' || peek() === '-') { const op = consume(); const right = product(); value = finite(op === '+' ? value + right : value - right); } return value; };
  const result = sum();
  if (position !== tokens.length) throw new Error('表达式格式不正确');
  return Object.is(result, -0) ? 0 : result;
}

export async function searchKnowledge(query: string, limit = 3, signal?: AbortSignal): Promise<KnowledgeItem[]> {
  signal?.throwIfAborted();
  const raw = await readFile(new URL('../data/knowledge/articles.json', import.meta.url), { encoding: 'utf8', signal });
  const articles = JSON.parse(raw) as KnowledgeItem[];
  const stopwords = /不存在|请帮我|帮我|请问|查一下|一下|有关|相关|关于|资料|内容|文档|搜索|检索|本地|哪些|如何|什么|介绍|说明|的|和|与|在|中|是|有|我/gu;
  const normalized = query.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(stopwords, ' ');
  const terms = [...new Set(normalized.match(/[a-z0-9_]+|[\p{Script=Han}]{2,}/gu) ?? [])];
  const grams = [...new Set(terms.flatMap(term => /\p{Script=Han}/u.test(term) ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term]))];
  const scores = articles.map(item => {
    const title = `${item.title} ${item.summary}`.toLowerCase();
    const body = item.content.toLowerCase();
    const score = terms.reduce((n, term) => n + (title.includes(term) ? 12 : body.includes(term) ? 4 : 0), 0)
      + grams.reduce((n, gram) => n + (title.includes(gram) ? 3 : body.includes(gram) ? 1 : 0), 0);
    return { item, score };
  });
  signal?.throwIfAborted();
  return scores.filter(entry => entry.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.item);
}

type ToolHandler = (args: unknown, signal: AbortSignal) => ToolResult | Promise<ToolResult>;
const toolRegistry = new Map<string, ToolHandler>([
  ['calculate', (args, signal) => {
    const { expression } = calculatorSchema.parse(args);
    const value = calculate(expression);
    signal.throwIfAborted();
    return { type: 'calculator', expression, value };
  }],
  ['search_knowledge', async (args, signal) => {
    const { query, limit } = searchSchema.parse(args);
    return { type: 'knowledge', query, items: await searchKnowledge(query, limit, signal) };
  }],
]);

export async function executeTool(name: string, rawArguments: string, signal: AbortSignal, timeoutMs = 10_000): Promise<ToolResult> {
  signal.throwIfAborted();
  if (rawArguments.length > 8_000) return { type: 'error', message: '工具参数超出长度限制' };
  let args: unknown;
  try { args = JSON.parse(rawArguments); } catch { return { type: 'error', message: '工具参数不是有效的 JSON' }; }
  const timerSignal = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timerSignal]);
  try {
    const handler = toolRegistry.get(name);
    if (!handler) return { type: 'error', message: `未知工具：${name.slice(0, 80)}` };
    const result = await handler(args, combined);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timerSignal.aborted) return { type: 'error', message: '工具执行超时，请缩小查询范围后重试' };
    return { type: 'error', message: error instanceof z.ZodError ? '工具参数不符合要求' : error instanceof Error ? error.message : '工具执行失败' };
  }
}
