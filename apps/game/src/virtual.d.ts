declare module 'virtual:kq-content' {
  import type { ClientContent } from './content/types';
  const content: ClientContent;
  export default content;
}

declare module 'virtual:kq-assets' {
  /** Manifest key ('char.pan', 'scene.kitchen', 'item.rice', ...) → served URL. */
  const assets: Readonly<Record<string, string>>;
  export default assets;
}

declare module 'virtual:kq-market' {
  /** The lazy market module (M6 Step 5): only src/market/content.ts imports it, dynamically. */
  import type { MarketContent } from './content/types';
  const market: MarketContent;
  export default market;
}
