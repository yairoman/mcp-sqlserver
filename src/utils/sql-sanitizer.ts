import { McpToolError } from "./error-handler.js";

/**
 * SQL Sanitizer — text-level checks for caller-supplied T-SQL and identifiers.
 *
 * This is a filter, not a parser, and it is NOT the security boundary: the
 * least-privilege login and the always-rolled-back transaction are (see README).
 * It is deliberately conservative: when in doubt, it rejects.
 *
 * None of the regexes below carry the `g` flag, so `.test()` keeps no state
 * between calls (a stateful `lastIndex` let a retried query slip through).
 */

/** Comments are rejected anywhere in the raw text, even inside string literals. */
const COMMENT_PATTERN = /--|\/\*|\*\//;

/**
 * Leading SET statements that may precede the SELECT / WITH.
 *
 * SERIALIZABLE is deliberately absent: it holds key-range locks until the
 * forced rollback, so a long read can block other sessions' writes for its
 * whole duration. Without a match here the body starts with SET and is rejected.
 */
const ALLOWED_SET_PREFIX =
  /^SET\s+(?:(?:NOCOUNT|ANSI_NULLS|QUOTED_IDENTIFIER|STATISTICS\s+(?:IO|TIME|XML|PROFILE)|SHOWPLAN_(?:TEXT|ALL|XML))\s+(?:ON|OFF)|TRANSACTION\s+ISOLATION\s+LEVEL\s+(?:READ\s+UNCOMMITTED|READ\s+COMMITTED|REPEATABLE\s+READ|SNAPSHOT))\s*(?:;\s*|\s+|$)/i;

/**
 * Keywords that never belong in a read-only query. Matched per token (see
 * findForbiddenToken) on the
 * code only (string literals and quoted identifiers are blanked out first), so a
 * column called [Update] or a literal 'DELETE' does not trigger them.
 */
const FORBIDDEN_KEYWORDS = [
  // DML / DDL
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "INTO",
  "CREATE", "ALTER", "DROP",
  // Permissions
  "GRANT", "REVOKE", "DENY",
  // Procedural code and dynamic SQL
  "EXEC", "EXECUTE", "DECLARE", "SET", "SETUSER", "REVERT",
  // Transaction control — would defeat the forced rollback
  "BEGIN", "COMMIT", "ROLLBACK", "SAVE",
  // Context switch and server operations
  "USE", "DBCC", "BACKUP", "RESTORE", "KILL", "SHUTDOWN", "RECONFIGURE", "CHECKPOINT",
  // External / remote data access
  "OPENROWSET", "OPENDATASOURCE", "OPENQUERY", "BULK",
  // Service Broker and legacy text writes (destructive)
  "RECEIVE", "SEND", "WRITETEXT", "UPDATETEXT",
  // Delays
  "WAITFOR",
  // Range-lock table hints: same effect as the SERIALIZABLE level the SET prefix refuses
  "SERIALIZABLE", "HOLDLOCK",
];

const FORBIDDEN_KEYWORD_SET = new Set(FORBIDDEN_KEYWORDS);

/** Extended and configuration procedures, even without EXEC. */
const FORBIDDEN_PROCEDURES = ["XP_", "SP_OA", "SP_CONFIGURE", "SP_EXECUTESQL"];

/** A forbidden keyword at the very end of a run (see findForbiddenToken). */
const KEYWORD_SUFFIX = new RegExp(`(?:${FORBIDDEN_KEYWORDS.join("|")})$`);

/**
 * Find a forbidden keyword or procedure in already-masked code.
 *
 * The code is split into runs of `[A-Za-z0-9_@#$]`. Their boundaries follow how
 * T-SQL splits tokens, not regex `\b`:
 *
 * - A run that starts with a letter, `_`, `@` or `#` is a single identifier for
 *   SQL Server (letters, digits, `_`, `@`, `#`, `$` all continue it), so it is
 *   compared whole: `DELETE` matches, `last_user_update` does not.
 * - A run that starts with a digit or `$` is a numeric, binary (`0x…`), float
 *   (`1E…`) or money (`$…`) literal, and SQL Server may end the literal at any
 *   letter and start a new token there: `1DELETE`, `0xATRUNCATE`, `$INSERT` are
 *   a literal followed by a keyword. Such a run is rejected if it ENDS with a
 *   forbidden keyword or contains a forbidden procedure prefix anywhere.
 *   This over-rejects odd inputs on purpose: when in doubt, reject.
 */
export function findForbiddenToken(maskedCode: string): string | null {
  for (const match of maskedCode.matchAll(/[A-Za-z0-9_@#$]+/g)) {
    const run = match[0].toUpperCase();
    const literalStart = /^[0-9$]/.test(run);
    if (literalStart) {
      const kw = KEYWORD_SUFFIX.exec(run);
      if (kw) return kw[0];
      const proc = FORBIDDEN_PROCEDURES.find((p) => run.includes(p));
      if (proc) return proc;
      continue;
    }
    if (FORBIDDEN_KEYWORD_SET.has(run)) return run;
    if (run.startsWith("XP_") || run.startsWith("SP_OA")) return run;
    if (run === "SP_CONFIGURE" || run === "SP_EXECUTESQL") return run;
  }
  return null;
}

/**
 * Blank out string literals ('...', N'...'), bracketed identifiers ([...]) and
 * double-quoted identifiers ("..."), keeping their length. Returns null when a
 * literal or identifier is left unterminated — the caller must reject the query.
 */
export function maskLiteralsAndIdentifiers(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const close = ch === "'" ? "'" : ch === '"' ? '"' : ch === "[" ? "]" : null;
    if (close === null) {
      out += ch;
      i++;
      continue;
    }
    // Find the closing delimiter; a doubled delimiter is an escaped one.
    let j = i + 1;
    let terminated = false;
    while (j < sql.length) {
      if (sql[j] === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        terminated = true;
        break;
      }
      j++;
    }
    if (!terminated) {
      return null;
    }
    // Keep the delimiters so the token boundaries stay where they were.
    out += ch + " ".repeat(j - i - 1) + close;
    i = j + 1;
  }
  return out;
}

/**
 * Validate that a query is a single read-only statement.
 *
 * Accepted shape: optional leading `SET <harmless option>` statements, then ONE
 * `SELECT` or `WITH` statement, optionally ended by `;`. Rejected: comments,
 * a second statement (with or without `;`) introduced by any forbidden keyword,
 * `SELECT … INTO`, CTEs feeding DML, `EXEC`, `DECLARE`, transaction control,
 * remote data access, and unterminated literals.
 */
export function isReadOnlyQuery(query: string): boolean {
  if (typeof query !== "string") {
    return false;
  }
  if (COMMENT_PATTERN.test(query)) {
    return false;
  }

  const masked = maskLiteralsAndIdentifiers(query);
  if (masked === null) {
    return false;
  }

  // Strip the allowed SET prefix statements, then optional leading ';' (";WITH").
  let body = masked.trim();
  let m: RegExpExecArray | null;
  while ((m = ALLOWED_SET_PREFIX.exec(body)) !== null) {
    body = body.slice(m[0].length).trim();
  }
  body = body.replace(/^;+\s*/, "");

  if (!/^(?:SELECT|WITH)\b/i.test(body)) {
    return false;
  }

  // A single statement: ';' only allowed as the very last character(s).
  const withoutTrailing = body.replace(/[;\s]+$/, "");
  if (withoutTrailing.includes(";")) {
    return false;
  }

  // ODBC escape sequences ({call proc}, {fn ...}) can invoke procedures without EXEC.
  if (/[{}]/.test(body)) {
    return false;
  }

  if (findForbiddenToken(body) !== null) {
    return false;
  }

  return true;
}

/**
 * Validate a query for dangerous patterns regardless of mode.
 * Matches on the raw text, string literals included, on purpose.
 * Returns an array of warnings.
 */
export function validateQuerySafety(query: string): string[] {
  const warnings: string[] = [];

  if (/xp_cmdshell/i.test(query)) {
    warnings.push("Query contains xp_cmdshell — this is extremely dangerous");
  }
  if (/OPENROWSET|OPENDATASOURCE/i.test(query)) {
    warnings.push("Query contains linked server commands — potential security risk");
  }
  if (/BULK\s+INSERT/i.test(query)) {
    warnings.push("Query contains BULK INSERT — potential security risk");
  }
  if (/WAITFOR\s+DELAY/i.test(query)) {
    warnings.push("Query contains WAITFOR DELAY — potential denial of service");
  }
  if (/SHUTDOWN/i.test(query)) {
    warnings.push("Query contains SHUTDOWN command");
  }

  return warnings;
}

/**
 * Sanitize a SQL identifier (database, schema, table, column name).
 *
 * The single identifier check of the project: one optional pair of wrapping
 * brackets is removed, then only letters, digits, `_`, `.`, `#` and `@` are
 * allowed. Anything else throws — it never silently strips characters, so the
 * caller can't end up addressing a different object than the one requested.
 */
export function sanitizeIdentifier(name: string): string {
  if (typeof name !== "string") {
    throw new Error("Invalid SQL identifier: expected a string.");
  }
  const trimmed = name.trim();
  const cleaned = /^\[.*\]$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  if (cleaned.length === 0 || cleaned.length > 128 || !/^[a-zA-Z0-9_.#@]+$/.test(cleaned)) {
    throw new Error(
      `Invalid SQL identifier: "${name}". Only alphanumeric characters, underscores, dots, # and @ are allowed (max 128).`
    );
  }
  return cleaned;
}

/**
 * Build a safe SQL identifier with bracket quoting.
 */
export function quoteIdentifier(name: string): string {
  const sanitized = sanitizeIdentifier(name);
  return `[${sanitized}]`;
}

/**
 * Bracket-quote a name read from the server (catalog views, DMVs), the way
 * QUOTENAME does: every `]` is doubled, so the name can never close the bracket
 * early. Use it for names that did NOT come through sanitizeIdentifier — a
 * column or database name is created by whoever has DDL rights on the server,
 * and may contain any character (second-order SQL injection otherwise).
 */
export function quoteName(name: string): string {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

/**
 * Quote a value as a Unicode string literal (N'...'), doubling every `'`.
 */
export function quoteLiteral(value: string): string {
  return `N'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build a two-part identifier: [schema].[name]
 */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/**
 * Throw unless `query` passes both the read-only check and the safety scan.
 * Use it before opening any connection.
 */
export function assertReadOnlyQuery(toolName: string, query: string): void {
  if (!isReadOnlyQuery(query)) {
    throw new McpToolError(
      toolName,
      "Query rejected: only a single read-only SELECT or WITH (CTE) statement is allowed."
    );
  }
  const warnings = validateQuerySafety(query);
  if (warnings.length > 0) {
    throw new McpToolError(
      toolName,
      "Query rejected: dangerous patterns detected.",
      warnings.join("; ")
    );
  }
}
