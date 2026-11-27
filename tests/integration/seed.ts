/**
 * Seed data of the throwaway database. Every value is synthetic.
 *
 * Several column names contain `]` on purpose: the integrity tools read names
 * from the catalog and must quote them (QUOTENAME-style, `]` doubled). If the
 * quoting broke, those tools would swallow the SQL error and report "no
 * issues", so each `]` column is the one that carries the expected finding.
 */

/** Names as SQL Server stores them (unquoted). */
export const SEED = {
  clientes: "Clientes",
  pedidos: "Pedidos",
  numeros: "Numeros",
  contador: "Contador",
  /** PK of Clientes, referenced by the FK. */
  refColumn: "Id]Cliente",
  /** FK column of Pedidos, with 2 orphan values (98, 99) and 1 NULL. */
  fkColumn: "Cliente]Id",
  /** VARCHAR column whose 10 values are all digits: "consider INT/BIGINT". */
  numericTextColumn: "Codigo]Postal",
  /** VARCHAR column whose 10 values are all dates: "consider DATE/DATETIME". */
  dateTextColumn: "Fecha]Texto",
  /** NVARCHAR column with 6 NULLs out of 10 rows. */
  mostlyNullColumn: "Notas",
  fkName: "FK_Pedidos_Clientes",
  pedidosRows: 10,
  orphanRows: 2,
  numerosRows: 1000,
} as const;

export const SEED_BATCHES: string[] = [
  `CREATE TABLE dbo.Clientes (
     [Id]]Cliente] INT NOT NULL CONSTRAINT PK_Clientes PRIMARY KEY,
     Nombre NVARCHAR(50) NOT NULL
   );
   INSERT dbo.Clientes ([Id]]Cliente], Nombre) VALUES (1, N'Uno'), (2, N'Dos'), (3, N'Tres');`,

  `CREATE TABLE dbo.Pedidos (
     PedidoId INT NOT NULL CONSTRAINT PK_Pedidos PRIMARY KEY,
     [Cliente]]Id] INT NULL,
     [Codigo]]Postal] VARCHAR(10) NOT NULL,
     [Fecha]]Texto] VARCHAR(20) NOT NULL,
     Notas NVARCHAR(100) NULL
   );
   INSERT dbo.Pedidos (PedidoId, [Cliente]]Id], [Codigo]]Postal], [Fecha]]Texto], Notas) VALUES
     (1, 1, '28001', '2026-01-01', N'a'),
     (2, 2, '28002', '2026-01-02', N'b'),
     (3, 3, '28003', '2026-01-03', N'c'),
     (4, 1, '28004', '2026-01-04', N'd'),
     (5, 2, '28005', '2026-01-05', NULL),
     (6, 3, '28006', '2026-01-06', NULL),
     (7, 1, '28007', '2026-01-07', NULL),
     (8, NULL, '28008', '2026-01-08', NULL),
     (9, 98, '28009', '2026-01-09', NULL),
     (10, 99, '28010', '2026-01-10', NULL);`,

  // WITH NOCHECK: the FK exists but the two orphans above are not validated.
  `ALTER TABLE dbo.Pedidos WITH NOCHECK
     ADD CONSTRAINT FK_Pedidos_Clientes FOREIGN KEY ([Cliente]]Id]) REFERENCES dbo.Clientes ([Id]]Cliente]);`,

  `CREATE TABLE dbo.Numeros (n INT NOT NULL CONSTRAINT PK_Numeros PRIMARY KEY);
   INSERT dbo.Numeros (n)
   SELECT TOP (1000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL))
   FROM sys.all_objects a CROSS JOIN sys.all_objects b;`,

  `CREATE TABLE dbo.Contador (Id INT NOT NULL CONSTRAINT PK_Contador PRIMARY KEY, Valor INT NOT NULL);
   INSERT dbo.Contador (Id, Valor) VALUES (1, 1);`,
];
