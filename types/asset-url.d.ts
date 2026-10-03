/**
 * `?url` imports, which Vite turns into the URL of the emitted asset.
 *
 * Declared here rather than by referencing `vite/client`: that brings in a whole
 * set of globals (`import.meta.env` among them) that WXT already provides, and
 * the two sets collide.
 *
 * The only use is ONNX Runtime's wasm pair — see `entrypoints/offscreen/kokoro.worker.ts`
 * and the aliases in `wxt.config.ts` for why they have to be imported by URL
 * rather than by the package's own export map.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
