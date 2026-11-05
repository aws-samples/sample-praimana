// Ambient declarations for static asset imports. Vite resolves these to URL
// strings at build time; this tells tsc their type so `type-check` (and the CI
// gate, EA-C3) passes without the "Cannot find module '*.png'" errors.
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.jpeg" {
  const src: string;
  export default src;
}
declare module "*.gif" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
