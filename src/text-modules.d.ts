/** Files imported as text: the template (plugin/src/*.liquid) and the BoM/CFA fixtures (*.xml). wrangler's "Text" rule does this for the Worker; the vitest plugin mirrors it. */
declare module "*.liquid" {
  const source: string;
  export default source;
}

declare module "*.xml" {
  const source: string;
  export default source;
}
