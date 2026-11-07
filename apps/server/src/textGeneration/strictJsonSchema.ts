type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenAI requires closed objects with every property required, including optional ones. */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const result: Record<string, unknown> = { ...schema };
  for (const key of ["$defs", "definitions", "patternProperties"]) {
    const entries = schema[key];
    if (isObject(entries))
      result[key] = Object.fromEntries(
        Object.entries(entries).map(([name, child]) => [name, toStrictJsonSchema(child)]),
      );
  }
  for (const key of ["items", "additionalProperties", "not", "contains"])
    if (schema[key] !== undefined) result[key] = toStrictJsonSchema(schema[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(schema[key])) result[key] = schema[key].map(toStrictJsonSchema);
  if (
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    isObject(schema.properties)
  ) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [
        key,
        required.has(key)
          ? toStrictJsonSchema(child)
          : { anyOf: [toStrictJsonSchema(child), { type: "null" }] },
      ]),
    );
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

function resolveRef(schema: JsonObject, root: unknown): unknown {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return undefined;
  let target = root;
  for (const part of schema.$ref.slice(2).split("/")) {
    if (!isObject(target)) return undefined;
    target = target[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return target;
}

// Choose a union branch before removing nulls, so required nullable fields stay intact.
function matches(value: unknown, schema: unknown, root: unknown): boolean {
  if (!isObject(schema)) return schema !== false;
  const ref = resolveRef(schema, root);
  if (ref !== undefined && !matches(value, ref, root)) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type !== undefined &&
    !types.some((type) => {
      switch (type) {
        case "null":
          return value === null;
        case "object":
          return isObject(value);
        case "array":
          return Array.isArray(value);
        case "integer":
          return typeof value === "number" && Number.isInteger(value);
        default:
          return typeof value === type;
      }
    })
  )
    return false;
  if (isObject(value) && isObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!(key in value)) {
        if (required.has(key)) return false;
      } else if (!(value[key] === null && !required.has(key)) && !matches(value[key], child, root))
        return false;
    }
  }
  for (const key of ["anyOf", "oneOf"])
    if (Array.isArray(schema[key]) && !schema[key].some((child) => matches(value, child, root)))
      return false;
  return true;
}

/** Restore omitted optional keys before decoding with the original Effect Schema. */
export function omitOptionalNulls(value: unknown, schema: unknown, root = schema): unknown {
  if (!isObject(schema)) return value;
  const ref = resolveRef(schema, root);
  if (ref !== undefined) value = omitOptionalNulls(value, ref, root);
  for (const key of ["anyOf", "oneOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const branch = branches.find((child) => matches(value, child, root));
      if (branch !== undefined) value = omitOptionalNulls(value, branch, root);
    }
  }
  if (Array.isArray(schema.allOf))
    for (const child of schema.allOf) value = omitOptionalNulls(value, child, root);
  if (Array.isArray(value))
    return value.map((item, index) =>
      omitOptionalNulls(
        item,
        Array.isArray(schema.prefixItems)
          ? (schema.prefixItems[index] ?? schema.items)
          : schema.items,
        root,
      ),
    );
  if (!isObject(value) || !isObject(schema.properties)) return value;
  const properties = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key in properties && child === null && !required.has(key)
        ? []
        : [[key, omitOptionalNulls(child, properties[key], root)]],
    ),
  );
}
