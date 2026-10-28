/**
 * The host enforces a strict JSON Schema subset for tool output and for
 * workflow/subagent structured output. These checks mirror that subset so a
 * schema mistake fails here rather than at activation in the running app.
 */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/**
 * Collect every violation in one schema tree.
 * @param {unknown} node - candidate schema node.
 * @param {string} path - diagnostic path.
 * @param {string[]} out - violation sink.
 */
export function checkSchema(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    out.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) return;
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) out.push(`${path}.oneOf must have at least two branches`);
    else node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, out));
    return;
  }
  if (!SCHEMA_TYPES.includes(node.type)) {
    out.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return;
  }
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') out.push(`${path}.additionalProperties must be explicitly true or false`);
    const properties = node.properties ?? {};
    for (const [key, value] of Object.entries(properties)) checkSchema(value, `${path}.properties.${key}`, out);
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        out.push(`${path}.required must be an array of strings`);
      } else {
        for (const key of node.required) {
          if (!Object.hasOwn(properties, key)) out.push(`${path}.required names "${key}" which is not in properties`);
        }
      }
    }
  }
  if (node.type === 'array' && node.items !== undefined) checkSchema(node.items, `${path}.items`, out);
  if (node.enum !== undefined && !Array.isArray(node.enum)) out.push(`${path}.enum must be an array`);
}

/**
 * Check one value against a schema in the same subset.
 * @param {object} schema - the schema node.
 * @param {unknown} value - candidate value.
 * @param {string} path - diagnostic path.
 * @param {string[]} out - violation sink.
 */
export function checkValue(schema, value, path, out) {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => {
      const scratch = [];
      checkValue(branch, value, path, scratch);
      return scratch.length === 0;
    });
    if (matches.length !== 1) out.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`);
    return;
  }
  if (value === undefined) {
    out.push(`${path} is undefined`);
    return;
  }
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.push(`${path} must be an object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) out.push(`${path}.${key} is not declared`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) checkValue(sub, value[key], `${path}.${key}`, out);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      out.push(`${path} must be an array`);
      return;
    }
    if (schema.items !== undefined) value.forEach((entry, index) => checkValue(schema.items, entry, `${path}[${index}]`, out));
    return;
  }
  if (type === 'string' && typeof value !== 'string') out.push(`${path} must be a string`);
  if (type === 'boolean' && typeof value !== 'boolean') out.push(`${path} must be a boolean`);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) out.push(`${path} must be a finite number`);
  if (type === 'integer' && !Number.isInteger(value)) out.push(`${path} must be an integer`);
  if (type === 'null' && value !== null) out.push(`${path} must be null`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) out.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
}
