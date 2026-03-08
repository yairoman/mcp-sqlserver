/**
 * Centralized error handler for the MCP server.
 */

export class McpToolError extends Error {
  public readonly toolName: string;
  public readonly details: string | undefined;

  constructor(toolName: string, message: string, details?: string) {
    super(message);
    this.name = "McpToolError";
    this.toolName = toolName;
    this.details = details;
  }
}

/**
 * Format an error for MCP response.
 * Always returns a user-friendly string.
 */
export function formatError(error: unknown, toolName: string): string {
  if (error instanceof McpToolError) {
    let msg = `❌ **${error.toolName}** error: ${error.message}`;
    if (error.details) {
      msg += `\n\nDetails: ${error.details}`;
    }
    return msg;
  }

  if (error instanceof Error) {
    // SQL Server specific errors
    if ("number" in error && typeof (error as Record<string, unknown>).number === "number") {
      const sqlError = error as Error & { number: number; state: number };
      return `❌ **SQL Server Error** (${sqlError.number}): ${sqlError.message}`;
    }

    // Connection errors
    if (error.message.includes("ECONNREFUSED")) {
      return `❌ **Connection Error**: Could not connect to SQL Server. Verify MSSQL_HOST and MSSQL_PORT are correct and the server is running.`;
    }
    if (error.message.includes("Login failed")) {
      return `❌ **Authentication Error**: Login failed. Verify MSSQL_USER and MSSQL_PASSWORD.`;
    }

    return `❌ **${toolName}** error: ${error.message}`;
  }

  return `❌ **${toolName}** unknown error: ${String(error)}`;
}

/**
 * Wrap a tool handler with error catching.
 */
export function withErrorHandling(
  toolName: string,
  handler: (args: Record<string, unknown>) => Promise<string>
): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>) => {
    try {
      return await handler(args);
    } catch (error) {
      return formatError(error, toolName);
    }
  };
}
