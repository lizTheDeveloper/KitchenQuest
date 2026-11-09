declare module 'virtual:kq-content' {
  import type { GameContent } from './content/types';
  const content: GameContent;
  export default content;
}

declare module 'virtual:kq-assets' {
  /** Manifest key ('char.pan', 'scene.kitchen', 'item.rice', ...) → served URL. */
  const assets: Readonly<Record<string, string>>;
  export default assets;
}
