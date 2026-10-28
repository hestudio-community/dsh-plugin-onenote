/**
 * A faithful-enough stand-in for the host's `defineTool`.
 *
 * It mirrors the observable contract the tools rely on: the compiled parameter
 * schema, the output contract, and an `execute` that validates arguments before
 * calling the body. Schema compilation is intentionally shallow — the real host
 * performs the authoritative validation, and `test/schema.test.js` checks our
 * declarations against the same supported subset.
 */

/** Convert the author-facing `{ prop: { type, required } }` map to JSON Schema. */
function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec ?? {})) {
    const node = {};
    if (value.description !== undefined) node.description = value.description;
    if (value.enum !== undefined) node.enum = value.enum;
    if (value.items !== undefined) node.items = compileParameters({ item: value.items }).properties.item ?? value.items;
    if (value.type !== undefined) node.type = value.type;
    if (value.type === 'object' && value.properties !== undefined) {
      const inner = compileParameters(value.properties);
      node.properties = inner.properties;
      if (inner.required.length > 0) node.required = inner.required;
    }
    if (value.type === 'array' && value.items !== undefined) {
      node.items = compileParameters({ item: value.items }).properties.item ?? { type: 'string' };
    }
    properties[key] = node;
    if (value.required === true) required.push(key);
  }
  return { properties, required };
}

export function defineTool(options) {
  const compiled = compileParameters(options.parameters);
  const parameters = { type: 'object', properties: compiled.properties };
  if (compiled.required.length > 0) parameters.required = compiled.required;
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    isConcurrencySafe: options.isConcurrencySafe,
    async execute(args, exec) {
      const missing = compiled.required.filter((key) => args === null || args === undefined || args[key] === undefined);
      if (missing.length > 0) throw new Error(`invalid arguments: missing required property "${missing[0]}"`);
      return options.execute(args ?? {}, exec);
    },
  };
}
