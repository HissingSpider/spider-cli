/**
 * Per-million-token list prices, used only to estimate. SpiderAI does not bill
 * students directly and exposes no pricing endpoint, so these track the public
 * upstream rates and are an approximation of consumption, not an invoice.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export class CostTracker {
  input = 0;
  output = 0;
  turns = 0;
  private byModel = new Map<string, { input: number; output: number }>();

  add(model: string, usage: { input: number; output: number }): void {
    this.input += usage.input;
    this.output += usage.output;
    this.turns++;
    const cur = this.byModel.get(model) ?? { input: 0, output: 0 };
    cur.input += usage.input;
    cur.output += usage.output;
    this.byModel.set(model, cur);
  }

  estimateUSD(): number {
    let total = 0;
    for (const [model, u] of this.byModel) {
      const p = PRICING[model];
      if (!p) continue;
      total += (u.input / 1e6) * p.input + (u.output / 1e6) * p.output;
    }
    return total;
  }

  summary(): string {
    const usd = this.estimateUSD();
    return (
      this.input.toLocaleString() +
      ' in / ' +
      this.output.toLocaleString() +
      ' out tokens' +
      ' across ' +
      this.turns +
      ' model call' +
      (this.turns === 1 ? '' : 's') +
      '\nEstimated at list prices: $' +
      usd.toFixed(4) +
      ' (SpiderAI does not bill you for this)'
    );
  }
}
