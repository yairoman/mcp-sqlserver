import { describe, it, expect } from "vitest";
import {
  isReadOnlyQuery,
  validateQuerySafety,
  sanitizeIdentifier,
  quoteIdentifier,
  maskLiteralsAndIdentifiers,
  assertReadOnlyQuery,
} from "../src/utils/sql-sanitizer.js";

// REVIEW §3.1: every one of these was accepted before the fix.
const BYPASSES: Array<[string, string]> = [
  ["second statement without ';'", "SELECT 1 DROP TABLE t"],
  ["CTE feeding a DELETE", "WITH x AS (SELECT 1 a) DELETE FROM t"],
  ["SELECT INTO", "SELECT * INTO t2 FROM t"],
  ["MERGE after SELECT", "SELECT 1 MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE;"],
  ["DECLARE + dynamic EXEC", "SELECT 1; DECLARE @s nvarchar(100) = N'DROP TABLE t'; EXEC(@s)"],
  ["SET prefix followed by UPDATE", "SET NOCOUNT ON UPDATE t SET a=1"],
  ["EXEC without ';'", "SELECT 1 EXEC sp_addsrvrolemember 'u','sysadmin'"],
  ["second statement with ';'", "SELECT 1; DROP TABLE t"],
];

const MORE_REJECTS: Array<[string, string]> = [
  ["INSERT", "INSERT INTO t VALUES (1)"],
  ["UPDATE", "UPDATE t SET a = 1"],
  ["EXECUTE keyword", "SELECT 1 EXECUTE ('DROP TABLE t')"],
  ["COMMIT would defeat the rollback", "SELECT 1 COMMIT"],
  ["BEGIN TRAN", "SELECT 1 BEGIN TRAN"],
  ["ROLLBACK", "SELECT 1 ROLLBACK"],
  ["SAVE TRAN", "SELECT 1 SAVE TRAN x"],
  ["USE switches database", "SELECT 1 USE master"],
  ["xp_ without EXEC", "SELECT * FROM t xp_cmdshell"],
  ["sp_executesql", "SELECT 1 sp_executesql N'SELECT 1'"],
  ["OPENQUERY", "SELECT * FROM OPENQUERY(srv, 'SELECT 1')"],
  ["OPENROWSET", "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')"],
  ["WAITFOR", "SELECT 1 WAITFOR DELAY '00:00:10'"],
  ["SET after the body", "SELECT 1 SET ROWCOUNT 0"],
  ["line comment", "SELECT 1 -- DROP"],
  ["block comment", "SELECT /* x */ 1"],
  ["comment inside a literal (conservative)", "SELECT 'a--b'"],
  ["unterminated literal", "SELECT 'abc"],
  ["unterminated bracket", "SELECT [abc FROM t"],
  ["does not start with SELECT/WITH", "EXEC sp_who"],
  ["empty", ""],
  ["disallowed SET option", "SET IDENTITY_INSERT t ON SELECT 1"],
  ["CREATE", "SELECT 1 CREATE TABLE x (a int)"],
  ["TRUNCATE", "SELECT 1 TRUNCATE TABLE t"],
  ["GRANT", "SELECT 1 GRANT CONTROL TO u"],
  ["DBCC", "SELECT 1 DBCC FREEPROCCACHE"],
  ["RECEIVE (destructive dequeue)", "SELECT 1 RECEIVE TOP (1) * FROM q"],
  // A number ends where a letter starts: these are two statements for SQL Server.
  ["keyword glued to a number: 1DELETE", "SELECT 1DELETE FROM t"],
  ["keyword glued to a number: 1COMMIT", "SELECT 1COMMIT"],
  ["keyword glued to a number: 1DROP", "SELECT 1DROP TABLE t"],
  ["keyword glued to a decimal: 1.5EXEC", "SELECT 1.5EXEC sp_who"],
  ["keyword after a closing paren", "SELECT (1)DELETE FROM t"],
  ["xp_ glued to a number", "SELECT 1xp_cmdshell 'dir'"],
  // Binary, float and money literals end where SQL Server decides, not at a digit.
  ["keyword after an empty binary literal: 0xINSERT", "SELECT 0xINSERT t VALUES(1)"],
  ["keyword after a hex digit: 0xATRUNCATE", "SELECT 0xATRUNCATE TABLE t"],
  ["keyword after a float exponent: 1EINSERT", "SELECT 1EINSERT t VALUES(1)"],
  ["keyword after a money sign: $INSERT", "SELECT $INSERT t VALUES(1)"],
  ["keyword after a money amount: $1.5DELETE", "SELECT $1.5DELETE FROM t"],
  ["keyword after a float with sign: 1E+3DROP", "SELECT 1E+3DROP TABLE t"],
  ["keyword glued after a closing literal", "SELECT 'x'DELETE FROM t"],
  ["keyword glued after a bracketed identifier", "SELECT [a]DELETE FROM t"],
  ["sp_executesql after a binary literal", "SELECT 0xsp_executesql N'x'"],
  ["ODBC call escape", "SELECT 1 {call sp_addsrvrolemember('u','sysadmin')}"],
  ["ODBC function escape", "SELECT {fn CURDATE()}"],
];

// SERIALIZABLE keeps range locks until the forced rollback and can block other
// sessions for the whole query. Rejected as a SET prefix and as a table hint.
const SERIALIZABLE_REJECTS: Array<[string, string]> = [
  ["SET SERIALIZABLE", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE SELECT 1"],
  ["SET SERIALIZABLE with ';'", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1"],
  ["lowercase", "set transaction isolation level serializable; select 1"],
  ["mixed case", "Set Transaction Isolation Level SeRiAlIzAbLe SELECT 1"],
  ["tabs", "SET\tTRANSACTION\tISOLATION\tLEVEL\tSERIALIZABLE\tSELECT 1"],
  ["newlines", "SET TRANSACTION\nISOLATION LEVEL\nSERIALIZABLE\nSELECT 1"],
  ["CRLF", "SET TRANSACTION ISOLATION LEVEL\r\nSERIALIZABLE;\r\nSELECT 1"],
  ["several spaces", "SET   TRANSACTION   ISOLATION    LEVEL     SERIALIZABLE   SELECT 1"],
  ["after another SET", "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1"],
  [
    "chained after a safe level, no ';'",
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED SET TRANSACTION ISOLATION LEVEL SERIALIZABLE SELECT 1",
  ],
  ["block comment between words", "SET TRANSACTION ISOLATION LEVEL/**/SERIALIZABLE SELECT 1"],
  ["line comment between words", "SET TRANSACTION ISOLATION LEVEL --x\nSERIALIZABLE\nSELECT 1"],
  ["table hint SERIALIZABLE", "SELECT a FROM dbo.t WITH (SERIALIZABLE) WHERE b = 1"],
  ["table hint HOLDLOCK", "SELECT a FROM dbo.t WITH (HOLDLOCK) WHERE b = 1"],
  ["table hint holdlock, lowercase and combined", "select a from dbo.t with (nolock, holdlock)"],
];

// Realistic read-only queries the audit workflow relies on. Over-blocking these
// would break the repository's main purpose.
const ACCEPTS: Array<[string, string]> = [
  ["simple SELECT", "SELECT 1"],
  ["trailing ';'", "SELECT * FROM dbo.Pedidos;"],
  ["CTE", "WITH x AS (SELECT 1 AS a) SELECT a FROM x"],
  [";WITH", ";WITH x AS (SELECT 1 AS a) SELECT a FROM x"],
  [
    "dm_exec_query_stats",
    "SELECT TOP 20 qs.execution_count, qs.total_worker_time, st.text FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st ORDER BY qs.total_worker_time DESC",
  ],
  [
    "index usage (user_updates, last_user_update)",
    "SELECT s.user_seeks, s.user_scans, s.user_updates, s.last_user_update FROM sys.dm_db_index_usage_stats s",
  ],
  ["create_date / modify_date", "SELECT name, create_date, modify_date FROM sys.objects"],
  ["literal containing DELETE", "SELECT * FROM dbo.Audit WHERE action = 'DELETE'"],
  ["N literal with escaped quote", "SELECT N'it''s; DROP TABLE t' AS s"],
  ["bracketed column named like a keyword", "SELECT [Update], [Insert], [Exec] FROM dbo.Log"],
  ["SET prefix with ';'", "SET NOCOUNT ON; SELECT 1"],
  [
    "several SET prefixes",
    "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT name FROM sys.databases",
  ],
  ["SET READ COMMITTED", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT 1"],
  ["SET SNAPSHOT", "SET TRANSACTION ISOLATION LEVEL SNAPSHOT SELECT 1"],
  ["SET read uncommitted, lowercase", "set transaction isolation level read uncommitted; select 1"],
  ["SET snapshot across newlines", "SET TRANSACTION ISOLATION LEVEL\nsnapshot\nSELECT 1"],
  [
    "'Serializable' as a literal (decoding transaction_isolation_level)",
    "SELECT CASE transaction_isolation_level WHEN 4 THEN 'Serializable' END FROM sys.dm_exec_sessions",
  ],
  ["[Serializable] as a bracketed alias", "SELECT 1 AS [Serializable], 2 AS [HoldLock]"],
  ["SET STATISTICS IO prefix", "SET STATISTICS IO ON SELECT COUNT(*) FROM dbo.t"],
  ["table hint", "SELECT a FROM dbo.t WITH (NOLOCK) WHERE b = 1"],
  ["FOR XML / OPTION", "SELECT name FROM sys.tables FOR XML PATH('') OPTION (RECOMPILE)"],
  ["lowercase", "select top 5 * from sys.dm_os_wait_stats order by wait_time_ms desc"],
  ["column like exp_date (no xp_ match)", "SELECT exp_date FROM dbo.Cards"],
];

describe("isReadOnlyQuery: REVIEW §3.1 regressions", () => {
  it.each(BYPASSES)("rejects %s", (_label, sql) => {
    expect(isReadOnlyQuery(sql)).toBe(false);
  });

  it.each(MORE_REJECTS)("rejects %s", (_label, sql) => {
    expect(isReadOnlyQuery(sql)).toBe(false);
  });

  it.each(SERIALIZABLE_REJECTS)("rejects SERIALIZABLE: %s", (_label, sql) => {
    expect(isReadOnlyQuery(sql)).toBe(false);
  });

  it.each(ACCEPTS)("accepts %s", (_label, sql) => {
    expect(isReadOnlyQuery(sql)).toBe(true);
  });

  it("gives the same answer when the same query is retried (no regex state)", () => {
    const bad = "SELECT 1; DROP TABLE t";
    expect([isReadOnlyQuery(bad), isReadOnlyQuery(bad), isReadOnlyQuery(bad)]).toEqual([
      false,
      false,
      false,
    ]);
    const ok = "SELECT * FROM t";
    expect([isReadOnlyQuery(ok), isReadOnlyQuery(ok), isReadOnlyQuery(ok)]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("alternating good/bad calls keep returning the right answer", () => {
    for (let i = 0; i < 5; i++) {
      expect(isReadOnlyQuery("SELECT 1 -- x")).toBe(false);
      expect(isReadOnlyQuery("SELECT 1")).toBe(true);
    }
  });

  it("rejects non-string input", () => {
    expect(isReadOnlyQuery(undefined as unknown as string)).toBe(false);
  });
});

describe("validateQuerySafety", () => {
  it("flags dangerous patterns, literals included", () => {
    expect(validateQuerySafety("SELECT 'QDS_SHUTDOWN_QUEUE'")).toHaveLength(1);
    expect(validateQuerySafety("SELECT 1 WAITFOR DELAY '00:00:01'")).toHaveLength(1);
    expect(validateQuerySafety("SELECT 1")).toEqual([]);
  });

  it("is stable across repeated calls", () => {
    const sql = "EXEC xp_cmdshell 'dir'";
    expect(validateQuerySafety(sql)).toHaveLength(1);
    expect(validateQuerySafety(sql)).toHaveLength(1);
  });
});

describe("assertReadOnlyQuery", () => {
  it("throws on a write and on a dangerous pattern, passes a plain SELECT", () => {
    expect(() => assertReadOnlyQuery("t", "DELETE FROM x")).toThrow(/rejected/);
    expect(() => assertReadOnlyQuery("t", "SELECT 'SHUTDOWN'")).toThrow(/dangerous/);
    expect(() =>
      assertReadOnlyQuery("t", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1"),
    ).toThrow(/rejected/);
    expect(() => assertReadOnlyQuery("t", "SELECT 1")).not.toThrow();
  });
});

describe("maskLiteralsAndIdentifiers", () => {
  it("blanks literal and identifier contents but keeps length and delimiters", () => {
    const sql = `SELECT 'a''b', [c]]d], "e" FROM t`;
    const masked = maskLiteralsAndIdentifiers(sql);
    expect(masked).toBe(`SELECT '    ', [    ], " " FROM t`);
    expect(masked!.length).toBe(sql.length);
  });

  it("returns null when unterminated", () => {
    expect(maskLiteralsAndIdentifiers("SELECT 'x")).toBeNull();
    expect(maskLiteralsAndIdentifiers(`SELECT "x`)).toBeNull();
    expect(maskLiteralsAndIdentifiers("SELECT [x")).toBeNull();
  });
});

describe("sanitizeIdentifier (single implementation)", () => {
  it("accepts plain and bracketed names", () => {
    expect(sanitizeIdentifier("Pedidos")).toBe("Pedidos");
    expect(sanitizeIdentifier("[Pedidos]")).toBe("Pedidos");
    expect(sanitizeIdentifier("#tmp")).toBe("#tmp");
    expect(quoteIdentifier("dbo")).toBe("[dbo]");
  });

  it("throws instead of silently stripping characters", () => {
    expect(() => sanitizeIdentifier("My-DB")).toThrow(/Invalid SQL identifier/);
    expect(() => sanitizeIdentifier("t]; DROP TABLE x")).toThrow();
    expect(() => sanitizeIdentifier("a b")).toThrow();
    expect(() => sanitizeIdentifier("")).toThrow();
    expect(() => sanitizeIdentifier("x".repeat(129))).toThrow();
    expect(() => sanitizeIdentifier(undefined as unknown as string)).toThrow();
  });
});
