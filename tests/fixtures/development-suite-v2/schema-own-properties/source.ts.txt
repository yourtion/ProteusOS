/**
 * JSON Schema 子集校验器（M0）。
 * 支持关键字：type / required / properties / items / minItems / minimum /
 * additionalProperties(false) / enum——覆盖 seed 验收 schema 的需要；
 * 不做完整 JSON Schema 实现，未识别的关键字被忽略。
 */

export interface SchemaError {
  path: string;
  message: string;
}

export function validateSchema(value: unknown, schema: unknown, path = "$"): SchemaError[] {
  if (typeof schema !== "object" || schema === null) {
    return [{ path, message: `schema 本身无效：${String(schema)}` }];
  }
  const s = schema as Record<string, unknown>;
  const errors: SchemaError[] = [];

  if (s.type !== undefined) {
    if (!typeMatches(value, s.type)) {
      errors.push({ path, message: `期望 type=${String(s.type)}，实际 ${typeName(value)}` });
      return errors; // 类型不符时后续关键字没有意义
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) errors.push({ path: `${path}.${key}`, message: "缺少必填字段" });
    }
    const properties =
      typeof s.properties === "object" && s.properties !== null
        ? (s.properties as Record<string, unknown>)
        : {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in record) errors.push(...validateSchema(record[key], subSchema, `${path}.${key}`));
    }
    if (s.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key))
          errors.push({ path: `${path}.${key}`, message: "additionalProperties 不允许该字段" });
      }
    }
  }

  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < (s.minItems as number)) {
      errors.push({
        path,
        message: `数组长度 ${value.length} 小于 minItems=${String(s.minItems)}`,
      });
    }
    if (s.items !== undefined) {
      value.forEach((item, i) => errors.push(...validateSchema(item, s.items, `${path}[${i}]`)));
    }
  }

  if (typeof value === "number" && s.minimum !== undefined && value < (s.minimum as number)) {
    errors.push({ path, message: `${value} 小于 minimum=${String(s.minimum)}` });
  }

  if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(value)) {
    errors.push({ path, message: `不在 enum 取值内` });
  }

  return errors;
}

function typeMatches(value: unknown, expected: unknown): boolean {
  switch (expected) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
