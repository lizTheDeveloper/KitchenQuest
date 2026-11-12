let stockAsk: string | null = null;
/**
 * The check-off card's "Out of stock?" (M6 Step 10, C31): the row whose stock control `#/market` opens and scrolls to,
 * once. Memory only, and outside first paint (only the check-off card and the market list import it).
 */
export function askStock(key: string): void { stockAsk = key; }
export function takeStockAsk(): string | null {
  const k = stockAsk;
  stockAsk = null;
  return k;
}
