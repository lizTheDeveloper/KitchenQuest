// Module hooks for fault-preload.mjs: boot.ts's import of the fake engines resolves to the fault engines.
const FAULT = new URL('./fault-engines.ts', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (/^\.\/engines\/fake\.(js|ts)$/.test(specifier) && /\/src\/boot\.ts(\?|$)/.test(context.parentURL ?? '')) return { url: FAULT, shortCircuit: true };
  return next(specifier, context);
}
