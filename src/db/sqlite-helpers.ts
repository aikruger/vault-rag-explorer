export type SqlJsParameter = string | number | null | Uint8Array;

export function normaliseSqlParameter(value: unknown): SqlJsParameter {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  throw new TypeError(
    `Unsupported SQLite parameter type: ${Object.prototype.toString.call(value)}`
  );
}

export function normaliseSqlParameters(values: unknown[]): (string | number | null | Uint8Array)[] {
  return values.map(normaliseSqlParameter);
}

export function normaliseSqlParameterObject(obj: Record<string, unknown>): Record<string, string | number | null | Uint8Array> {
  const result: Record<string, string | number | null | Uint8Array> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = normaliseSqlParameter(value);
  }
  return result;
}

export function logSqlOperation(operation: string, sql: string, parameters: unknown[]) {
  console.log("[Database] executing SQL statement", {
    operation,
    sql,
    parameterCount: parameters.length,
    parameterTypes: parameters.map((value) =>
      value === null ? "null" : typeof value
    ),
  });
}
