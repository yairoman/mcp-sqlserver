/** Represents a column in a database table */
export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  defaultValue: string | null;
  description: string | null;
}

/** Represents a database table */
export interface TableInfo {
  schema: string;
  name: string;
  type: "TABLE" | "VIEW";
  rowCount: number;
  sizeKB: number;
  createdDate: string;
  modifiedDate: string;
}

/** Represents an index on a table */
export interface IndexInfo {
  name: string;
  type: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  columns: string[];
  includedColumns: string[];
  filterDefinition: string | null;
}

/** Represents a foreign key relationship */
export interface ForeignKeyInfo {
  name: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete: string;
  onUpdate: string;
}

/** Represents a stored procedure */
export interface StoredProcedureInfo {
  schema: string;
  name: string;
  createdDate: string;
  modifiedDate: string;
  parameters: ParameterInfo[];
}

/** Represents a stored procedure parameter */
export interface ParameterInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  isOutput: boolean;
  hasDefault: boolean;
}

/** Represents a trigger */
export interface TriggerInfo {
  name: string;
  parentSchema: string;
  parentTable: string;
  type: string;
  isEnabled: boolean;
  events: string[];
  definition: string | null;
}

/** Represents a view */
export interface ViewInfo {
  schema: string;
  name: string;
  createdDate: string;
  modifiedDate: string;
  definition: string | null;
}

/** Represents a database */
export interface DatabaseInfo {
  name: string;
  state: string;
  sizeGB: number;
  compatibilityLevel: number;
  collation: string;
  recoveryModel: string;
  createdDate: string;
}

/** Result for query execution */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
}

/** Tool registration helper */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}
