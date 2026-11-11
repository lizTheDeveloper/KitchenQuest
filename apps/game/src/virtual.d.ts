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
