// saxon-js ships no type definitions; only the part used here is declared.
declare module 'saxon-js' {
  const SaxonJS: {
    XPath: { evaluate(expression: string, context: unknown, options?: { params?: Record<string, unknown> }): unknown };
  };
  export default SaxonJS;
}
