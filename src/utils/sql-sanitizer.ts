/**
 * SQL Sanitizer — prevents SQL injection in dynamic queries.
 */

/** Reserved SQL keywords that should not be used as identifiers without quoting */
const DANGEROUS_PATTERNS = [
  /;\s*(DROP|ALTER|CREATE|TRUNCATE|DELETE|INSERT|UPDATE|EXEC|EXECUTE|GRANT|REVOKE|DENY)\b/gi,
  /--/g,
  /\/\*/g,
  /\*\//g,
  /xp_/gi,
  /sp_configure/gi,
  /OPENROWSET/gi,
  /OPENDATASOURCE/gi,
  /BULK\s+INSERT/gi,
];

/**
 * Sanitize a SQL identifier (database, schema, table, column name).
 * Only allows alphanumeric characters, underscores, and dots.
 */
export function sanitizeIdentifier(name: string): string {
  // Remove any bracket wrapping first
  const cleaned = name.replace(/^\[|\]$/g, "");
  // Only allow safe characters
  if (!/^[a-zA-Z0-9_.#@]+$/.test(cleaned)) {
    throw new Error(
      `Invalid SQL identifier: "${name}". Only alphanumeric characters, underscores, dots, # and @ are allowed.`
    );
  }
  return cleaned;
}

/**
 * Validate that a query is read-only (SELECT only).
 * Returns true if the query appears to contain only SELECT statements.
 */
export function isReadOnlyQuery(query: string): boolean {
  const trimmed = query.trim().toUpperCase();

  // Must start with SELECT, WITH, or SET (for SET options before SELECT)
  const allowedStarts = [
    /^SELECT\b/,
    /^WITH\b/,
    /^SET\s+(NOCOUNT|TRANSACTION\s+ISOLATION|ANSI_NULLS|QUOTED_IDENTIFIER|STATISTICS|SHOWPLAN)/,
  ];

  const startsWithAllowed = allowedStarts.some((pattern) =>
    pattern.test(trimmed)
  );
  if (!startsWithAllowed) {
    return false;
  }

  // Check for dangerous embedded statements
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      return false;
    }
    // Reset regex lastIndex
    pattern.lastIndex = 0;
  }

  return true;
}

/**
 * Validate a query for dangerous patterns regardless of mode.
 * Returns an array of warnings.
 */
export function validateQuerySafety(query: string): string[] {
  const warnings: string[] = [];

  if (/xp_cmdshell/gi.test(query)) {
    warnings.push("Query contains xp_cmdshell — this is extremely dangerous");
  }
  if (/OPENROWSET|OPENDATASOURCE/gi.test(query)) {
    warnings.push(
      "Query contains linked server commands — potential security risk"
    );
  }
  if (/BULK\s+INSERT/gi.test(query)) {
    warnings.push("Query contains BULK INSERT — potential security risk");
  }
  if (/WAITFOR\s+DELAY/gi.test(query)) {
    warnings.push(
      "Query contains WAITFOR DELAY — potential denial of service"
    );
  }
  if (/SHUTDOWN/gi.test(query)) {
    warnings.push("Query contains SHUTDOWN command");
  }

  return warnings;
}

/**
 * Build a safe SQL identifier with bracket quoting.
 */
export function quoteIdentifier(name: string): string {
  const sanitized = sanitizeIdentifier(name);
  return `[${sanitized}]`;
}

/**
 * Build a two-part identifier: [schema].[name]
 */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}
