import { describe, expect, it } from 'vitest';
import { calculate, executeTool, searchKnowledge } from '../server/tools.ts';

describe('bounded calculator', () => {
  it.each([['(128*36+259)/7', 695.2857142857143], ['-2^2', -4], ['2^3^2', 512], ['2^-2', 0.25], ['round(10/3,2)', 3.33], ['round(1.005,2)', 1.01], ['round(-1.005,2)', -1.01], ['sqrt(81)+max(2,4)', 13], ['1.2e3 + .5', 1200.5]])('calculates %s', (expression, answer) => {
    expect(calculate(expression)).toBeCloseTo(answer, 10);
  });
  it.each(['process.exit()', 'globalThis', '1/0', 'sqrt(-1)', '2 3', 'pow(2)', '1+', '9^999', 'round(1,99)', '1;2', '9007199254740993 - 9007199254740992'])('rejects unsafe or invalid expression %s', expression => {
    expect(() => calculate(expression)).toThrow();
  });
});

describe('real tools', () => {
  it('retrieves relevant local documents with visible sources', async () => {
    const matches = await searchKnowledge('停止生成 打断 取消', 2);
    expect(matches).toHaveLength(2);
    expect(matches[0].id).toBe('cancellation');
    expect(matches.every(match => match.source.startsWith('本地演示资料'))).toBe(true);
    expect(await searchKnowledge('unicorn_xyz_987')).toEqual([]);
    expect(await searchKnowledge('不存在的火星天气资料')).toEqual([]);
  });
  it('returns structured errors for invalid JSON, schema violations and unknown tools', async () => {
    const signal = new AbortController().signal;
    expect(await executeTool('calculate', '{', signal)).toMatchObject({ type: 'error' });
    expect(await executeTool('calculate', '{"expression":"2+2","extra":1}', signal)).toMatchObject({ type: 'error' });
    expect(await executeTool('search_knowledge', '{"query":"取消","limit":99}', signal)).toMatchObject({ type: 'error' });
    expect(await executeTool('unknown', '{}', signal)).toMatchObject({ type: 'error' });
    expect(await executeTool('calculate', '{"expression":"2+2"}', signal)).toEqual({ type: 'calculator', expression: '2+2', value: 4 });
  });
  it('does not execute after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(executeTool('calculate', '{"expression":"1+1"}', controller.signal)).rejects.toBeDefined();
    await expect(searchKnowledge('取消', 3, controller.signal)).rejects.toBeDefined();
  });
});
