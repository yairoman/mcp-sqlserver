import { z } from "zod";

/**
 * Runtime validation of tool arguments.
 *
 * Each tool declares its arguments once, as the JSON Schema in its `inputSchema`
 * (that is what MCP clients see). The low-level MCP `Server` does not enforce it,
 * so this module compiles that same schema into a zod schema per tool, and
 * `callTool()` parses every call with it before the handler runs.
 *
 * Supported subset (everything the tools use): object with properties/required,
 * string (+ enum), number / integer (+ minimum / maximum), boolean, array (+ items),
 * and untyped values. Unknown keys are rejected, so a removed parameter (such as the
 * old free-form `where`) fails loudly instead of being silently ignored.
 *
 * Numbers are coerced from numeric strings and clamped to [minimum, maximum];
 * integers are truncated. Booleans accept true/false and the strings "true"/"false".
 */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
  default?: unknown;
}

function numberSchema(node: JsonSchema): z.ZodTypeAny {
  const integer = node.type === "integer";
  return z
    .union([z.number(), z.string().trim().min(1)])
    .transform((v, ctx) => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a finite number" });
        return z.NEVER;
      }
      let out = integer ? Math.trunc(n) : n;
      if (node.minimum !== undefined) out = Math.max(out, node.minimum);
      if (node.maximum !== undefined) out = Math.min(out, node.maximum);
      return out;
    });
}

const booleanSchema = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === "true" || v === "false", { message: "Expected a boolean" })
    .transform((v) => v === "true"),
]);

export function jsonSchemaToZod(node: JsonSchema): z.ZodTypeAny {
  switch (node.type) {
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(node.required ?? []);
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const s = jsonSchemaToZod(child);
        shape[key] = required.has(key) ? s : s.optional();
      }
      return z.object(shape).strict();
    }
    case "string": {
      if (node.enum && node.enum.length > 0) {
        const allowed = node.enum.map(String);
        const normalize = (v: string) => v.trim().replace(/\s+/g, " ").toUpperCase();
        const allowedNorm = allowed.map(normalize);
        return z.string().refine((v) => allowedNorm.includes(normalize(v)), {
          message: `Expected one of: ${allowed.join(", ")}`,
        });
      }
      return z.string();
    }
    case "number":
    case "integer":
      return numberSchema(node);
    case "boolean":
      return booleanSchema;
    case "array":
      return z.array(node.items ? jsonSchemaToZod(node.items) : z.unknown());
    default:
      // Untyped value (e.g. a filter value that may be a scalar or an array).
      return z.unknown();
  }
}

/** Format zod issues as a short, readable list for the tool caller. */
export function formatArgIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(arguments)";
      return `- ${path}: ${i.message}`;
    })
    .join("\n");
}
