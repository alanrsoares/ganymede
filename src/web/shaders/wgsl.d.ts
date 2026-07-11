// `.wgsl` files are imported as raw text (Bun `with { type: "text" }`), so the
// default export is the shader source string.
declare module "*.wgsl" {
  const source: string;
  export default source;
}
