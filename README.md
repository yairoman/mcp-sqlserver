# mcp-sqlserver

**MCP Server para SQL Server** — Permite a cualquier LLM (Claude, Copilot, Cursor, etc.) conectarse a SQL Server para inspeccionar esquemas, leer datos, ejecutar queries, analizar performance y validar integridad de información.

## 📋 Requisitos

- **Node.js >= 22** (LTS) — verifica con `node -v`
- Acceso de red a una instancia de SQL Server y credenciales de un usuario SQL

## 🚀 Quick Start

### 1. Clonar el repositorio

```bash
git clone <url-del-repositorio> mcp-sqlserver
cd mcp-sqlserver
```

### 2. Instalar dependencias

```bash
npm install
```

> **⚠️ Este paso no es opcional en ninguna ruta de instalación**, ni siquiera si vas a usar la
> variante sin compilar (`npx tsx src/index.ts`). `npx` resuelve `tsx` desde su caché global, así
> que el comando *parece* autosuficiente, pero las dependencias del proyecto — `dotenv`, `mssql`,
> `@modelcontextprotocol/sdk`, `zod` — tienen que estar en `node_modules/`. Sin ellas el proceso
> muere al arrancar con `ERR_MODULE_NOT_FOUND` y el cliente MCP solo reporta `Connection closed`,
> sin más pistas. Ver [Troubleshooting](#-troubleshooting).

### 3. Configurar variables de entorno

Copia el archivo de ejemplo y edítalo con tus credenciales:

```bash
cp .env.example .env
```

Edita el `.env` con los datos de tu SQL Server:

```env
# Conexión SQL Server
MSSQL_HOST=tu-servidor          # IP o hostname del server
MSSQL_PORT=1433                 # Puerto (default: 1433)
MSSQL_USER=tu-usuario           # Login de solo lectura (ver "Login de mínimo privilegio"); nunca sa
MSSQL_PASSWORD=tu-password      # Contraseña
MSSQL_DATABASE=master           # Base de datos inicial

# Seguridad
MSSQL_ENCRYPT=true              # solo "false" (explícito) desactiva TLS
MSSQL_TRUST_SERVER_CERTIFICATE=false  # solo "true" (explícito) acepta certificados sin validar
MSSQL_READ_ONLY=true            # solo "false" (explícito) habilita escritura; cualquier otro valor = solo lectura

# Límites
MSSQL_MAX_ROWS=1000             # Máximo de filas por consulta
MSSQL_QUERY_TIMEOUT=30000       # Timeout de queries en ms
MSSQL_CONNECTION_TIMEOUT=15000  # Timeout de conexión en ms

# Pool de conexiones
MSSQL_POOL_MIN=1
MSSQL_POOL_MAX=10
```

> **💡 Nota**: El servidor carga el `.env` automáticamente usando `dotenv`, y lo busca **junto al
> repositorio, no en el directorio de trabajo**: la ruta se resuelve desde la ubicación del propio
> archivo (`src/index.ts` o `dist/index.js`), así que funciona sea cual sea el `cwd` desde el que
> lo lance el cliente. Si además defines variables de entorno en la configuración de tu cliente MCP
> (Claude, Codex, etc.), las del cliente tienen **prioridad** sobre el `.env`.

### 4. Compilar

```bash
npm run build
```

Esto genera `dist/index.js`, que es lo que apuntan la mayoría de las configuraciones de cliente de
abajo. **Puedes saltarte este paso** si prefieres ejecutar directamente el TypeScript: usa `npx`
como comando y `tsx /ruta/a/mcp-sqlserver/src/index.ts` como argumentos en cualquiera de los
clientes. Es la variante que usa el `.mcp.json` incluido en el repo.

### Configurar en Claude Code

**El repositorio ya incluye un `.mcp.json` en la raíz**, así que no hace falta configurar nada:
basta con abrir la carpeta del proyecto con Claude Code y aceptar el servidor cuando lo proponga.
La configuración incluida es:

```json
{
  "mcpServers": {
    "mcp-sqlserver": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": {}
    }
  }
}
```

Usa `tsx` sobre el TypeScript, de modo que **no requiere `npm run build`** — pero sí `npm install`.
El bloque `env` está vacío a propósito: las credenciales se leen del `.env`, que no se versiona.

Para usar el servidor desde **otro** proyecto, regístralo apuntando a la ruta absoluta:

```bash
claude mcp add mcp-sqlserver --scope user -- npx tsx /ruta/completa/a/mcp-sqlserver/src/index.ts
```

Comprueba el estado en cualquier momento con el comando `/mcp` dentro de Claude Code.

### Configurar en Claude Desktop

Edita `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["/ruta/completa/a/mcp-sqlserver/dist/index.js"],
      "env": {
        "MSSQL_HOST": "tu-servidor",
        "MSSQL_PORT": "1433",
        "MSSQL_USER": "tu-usuario",
        "MSSQL_PASSWORD": "tu-password",
        "MSSQL_DATABASE": "master",
        "MSSQL_TRUST_SERVER_CERTIFICATE": "true",
        "MSSQL_READ_ONLY": "true",
        "MSSQL_MAX_ROWS": "1000"
      }
    }
  }
}
```

### Configurar en Cursor / VS Code

Añadir a `.cursor/mcp.json` o la configuración MCP de tu editor:

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/ruta/completa/a/mcp-sqlserver",
      "env": {
        "MSSQL_HOST": "tu-servidor",
        "MSSQL_USER": "tu-usuario",
        "MSSQL_PASSWORD": "tu-password",
        "MSSQL_DATABASE": "master",
        "MSSQL_TRUST_SERVER_CERTIFICATE": "true"
      }
    }
  }
}
```

### Configurar en Antigravity (Google Gemini)

Añadir al archivo `.gemini/settings.json` en la raíz de tu proyecto:

```json
{
  "mcpServers": {
    "mcp-sqlserver": {
      "command": "node",
      "args": ["/ruta/completa/a/mcp-sqlserver/dist/index.js"],
      "env": {
        "MSSQL_HOST": "tu-servidor",
        "MSSQL_PORT": "1433",
        "MSSQL_USER": "tu-usuario",
        "MSSQL_PASSWORD": "tu-password",
        "MSSQL_DATABASE": "master",
        "MSSQL_TRUST_SERVER_CERTIFICATE": "true",
        "MSSQL_READ_ONLY": "true",
        "MSSQL_MAX_ROWS": "1000"
      }
    }
  }
}
```

### Configurar en Codex (OpenAI)

En Codex, ve a **Configuración > MCP > Conectar con un MCP personalizado** y llena los campos:

| Campo                    | Valor                              |
| ------------------------ | ---------------------------------- |
| **Nombre**               | `mcp-sqlserver`              |
| **Tipo**                 | `STDIO` (seleccionado por defecto) |
| **Comando para iniciar** | `node`                             |

**Argumentos** (clic en "+ Agregar argumento"):

| #   | Valor                                                |
| --- | ---------------------------------------------------- |
| 1   | `/ruta/completa/a/mcp-sqlserver/dist/index.js` |

**Variables de entorno** (clic en "+ Agregar variable de entorno" por cada una):

| Clave                            | Valor         |
| -------------------------------- | ------------- |
| `MSSQL_HOST`                     | `tu-servidor` |
| `MSSQL_PORT`                     | `1433`        |
| `MSSQL_USER`                     | `tu-usuario`  |
| `MSSQL_PASSWORD`                 | `tu-password` |
| `MSSQL_DATABASE`                 | `master`      |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | `true`        |
| `MSSQL_READ_ONLY`                | `true`        |
| `MSSQL_MAX_ROWS`                 | `1000`        |

**Directorio de trabajo**: `/ruta/completa/a/mcp-sqlserver`

Finalmente, clic en **Guardar**.

> **Alternativa sin compilar — aplica a todos los clientes de esta sección, no solo a Codex.**
> Usa `npx` como comando y `tsx` + `/ruta/a/mcp-sqlserver/src/index.ts` como argumentos para
> ejecutar directamente desde TypeScript, sin `npm run build`. Es lo que hace el `.mcp.json` del
> repo. `npm install` sigue siendo obligatorio.

---

## 🛠️ Tools Disponibles (33)

### 📋 Schema & Metadata (9)

| Tool                     | Descripción                                             |
| ------------------------ | ------------------------------------------------------- |
| `list_databases`         | Lista todas las bases de datos del servidor             |
| `list_tables`            | Lista tablas con row count, tamaño y filtro por esquema |
| `describe_table`         | Columnas, tipos, PKs, FKs, defaults, identity           |
| `list_views`             | Views con definición SQL opcional                       |
| `list_stored_procedures` | SPs con parámetros y definición                         |
| `list_triggers`          | Triggers con tipo, eventos y estado                     |
| `list_indexes`           | Índices con columnas y filtros                          |
| `list_foreign_keys`      | Relaciones FK con acciones de cascade                   |
| `get_object_definition`  | Código T-SQL de cualquier objeto                        |

### 📊 Data Access (4)

| Tool                   | Descripción                                         |
| ---------------------- | --------------------------------------------------- |
| `read_table_data`      | Lee datos de tablas con filtros estructurados y parametrizados (`filters`), paginación y orden |
| `execute_select_query` | Ejecuta SELECT arbitrario (validado como read-only) |
| `search_data`          | Busca valores con LIKE en columnas específicas      |
| `get_table_sample`     | Muestra representativa + estadísticas básicas       |

### ⚡ Query Execution (3)

| Tool             | Descripción                                          |
| ---------------- | ---------------------------------------------------- |
| `execute_query`  | Ejecuta cualquier query T-SQL (read-only/read-write) |
| `explain_query`  | Plan estimado de un `SELECT`/`WITH`, sin ejecutarlo  |
| `validate_query` | Sintaxis de un `SELECT`/`WITH`, sin ejecutarlo       |

### 📈 Performance & Monitoring (11)

| Tool                           | Descripción                                   |
| ------------------------------ | --------------------------------------------- |
| `get_index_usage_stats`        | Estadísticas de uso de índices                |
| `get_missing_indexes`          | Índices recomendados por el optimizer         |
| `get_active_sessions`          | Sesiones activas y queries en ejecución       |
| `get_blocking_chains`          | Cadenas de bloqueo activas en este instante   |
| `get_blocking_history`         | Bloqueos pasados: quién esperó y si se abortó |
| `get_wait_stats`               | Esperas: acumuladas o medidas en una ventana  |
| `get_performance_triage`       | ¿El servidor espera o trabaja? Con veredicto  |
| `get_table_statistics`         | Estadísticas de columnas y frescura           |
| `get_query_stats`              | Top queries por CPU/duración/lecturas         |
| `get_configuration_health`     | Auditoría de configuración, con juicio        |
| `get_compatibility_assessment` | Assessment de subida de compat level          |

> **`get_configuration_health` es la única tool que opina.** Las demás devuelven datos; esta los
> contrasta contra valores conocidos y clasifica cada hallazgo por severidad y por categoría —
> *Estabilidad*, *Diagnosticabilidad*, *Rendimiento*, *Integridad*—, que es lo que dice qué
> arreglar primero. Comprueba memoria, MAXDOP, umbral de paralelismo, archivos de tempdb, compat
> level **contra la versión real del motor**, RCSI, `auto_shrink`/`auto_close`/`page_verify`,
> retención de Change Tracking, estado de Query Store y si los bloqueos son diagnosticables.
> Audita **cómo está configurado** el motor, no cómo está escrito el código: una función escalar
> que quema horas de CPU no aparece aquí. El criterio sale de R-25 del skill
> `buenas-practicas-sql`, derivado de auditorías reales.

> **`get_compatibility_assessment` responde «¿qué pasa si subo el compat level?»** Acepta
> `targetLevel` **100 · 110 · 120 · 130 · 140 · 150 · 160 · 170**, es decir de SQL Server 2008 a
> **SQL Server 2025 (170)**. Si no se indica, asume el máximo que soporta el motor; si se pide uno
> por encima, lo topa y lo explica, porque una base no puede superar a su motor. Sin `database`,
> resume cuántas bases están por detrás y cuántas podrían migrar sin red.
>
> Lo que lo hace fiable es que **no adivina**: lee
> `sys.sql_modules.is_inlineable`, o sea la respuesta del propio optimizador sobre qué funciones
> escalares dejarían de ejecutarse fila por fila. En una base medida: 115 de 176 inlineables, y
> las 61 restantes seguirán igual a cualquier nivel — eso separa lo que se arregla solo de lo que
> exige reescritura. Comprueba además Query Store como prerequisito (sin él la subida no es
> reversible en la práctica), planes forzados, plan guides, configuraciones que entran en
> conflicto y frescura de estadísticas.
>
> ⚠️ Los cambios de comportamiento de **170** son los menos asentados de la tabla, y la propia
> salida lo advierte: son un punto de partida y hay que contrastarlos con la documentación del
> build concreto antes de planificar una migración. Los de 140, 150 y 160 sí están firmes.

> **Rendimiento: empieza por el triage.** `get_wait_stats` sin argumentos devuelve el acumulado
> **desde el arranque del servicio**, que sirve para ver tendencias pero **no** para diagnosticar
> lo que pasa ahora: con días de uptime, una tarde mala queda diluida y las esperas de fondo
> (hilos ociosos, backups) se comen el ranking. Pasa `sampleSeconds: 30` y toma dos muestras
> restándolas — en una medición real, el acumulado daba 76 % a un tipo de espera ocioso mientras
> la ventana de 30 s mostraba tempdb, paralelismo y CPU repartiéndose el 85 %.
>
> `get_performance_triage` hace eso y además clasifica las esperas por familia, comprueba si hay
> algo bloqueado ahora, y devuelve un veredicto con la siguiente tool a ejecutar. Es el primer
> paso ante un «va lento», antes de mirar consulta alguna: primero se decide si el servidor
> **espera** o **trabaja**.

> **Bloqueos: cuál usar.** `get_blocking_chains` lee `sys.dm_exec_requests`, así que solo ve lo
> que está bloqueado **ahora**; si el bloqueo terminó, no deja rastro. Para «¿tuvo bloqueos el
> servidor hoy?» usa `get_blocking_history`, que reconstruye el pasado desde Query Store.
> Sin argumentos barre todas las bases y devuelve un resumen; con `database` lista las consultas
> que esperaron. Query Store registra **quién esperó, no quién bloqueó**: para la cadena
> bloqueador→bloqueado hace falta el *blocked process report* (`blocked process threshold` > 0
> más una sesión de Extended Events), y la tool avisa si está apagado.

### 🔍 Integrity & Analysis (6)

| Tool                          | Descripción                            |
| ----------------------------- | -------------------------------------- |
| `check_referential_integrity` | Detecta registros huérfanos por FK     |
| `find_duplicate_records`      | Encuentra duplicados en columnas clave |
| `check_null_analysis`         | Análisis de NULLs por columna          |
| `validate_data_types`         | Detecta tipos de datos inconsistentes  |
| `get_row_counts_all_tables`   | Conteo de filas de todas las tablas    |
| `compare_table_schemas`       | Compara esquemas entre tablas          |

---

## Ejemplos de uso

Así se ve el servidor en una conversación real. En el día a día **no escribes JSON**: le pides
algo al LLM en lenguaje natural, el LLM elige la tool y sus argumentos, y te explica el resultado.
Cada ejemplo muestra las tres piezas: lo que pides, la llamada que hace el LLM y lo que devuelve
la tool.

> ⚠️ Todas las salidas son **ejemplo ilustrativo (datos ficticios)**. Están armadas a partir del
> formato que produce cada tool; los nombres, cifras y tiempos son inventados.

### La base de ejemplo: `TiendaDemo`

Una tienda online inventada, con cuatro tablas en el esquema `dbo`:

| Tabla                | Columnas principales                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `dbo.Clientes`       | `ClienteId` (PK), `Nombre`, `Email`, `FechaAlta`                            |
| `dbo.Productos`      | `ProductoId` (PK), `Nombre`, `Categoria`, `Precio`                          |
| `dbo.Pedidos`        | `PedidoId` (PK), `ClienteId` (FK → Clientes), `FechaPedido`, `Estado`, `Total` |
| `dbo.DetallePedidos` | `DetalleId` (PK), `PedidoId` (FK → Pedidos), `ProductoId` (FK → Productos), `Cantidad`, `PrecioUnitario` |

La conexión de los ejemplos apunta a `localhost` con un usuario de marcador (`<tu_usuario>`); la
configuración real se explica en la sección «Variables de Entorno».

### 1. Esquema — ¿cómo es una tabla?

**Tú:** «¿Qué columnas tiene la tabla de pedidos de TiendaDemo?»

**El LLM llama a** `describe_table`:

```json
{
  "database": "TiendaDemo",
  "schema": "dbo",
  "table": "Pedidos"
}
```

**Salida** — ejemplo ilustrativo (datos ficticios):

```text
**Columns in [TiendaDemo].[dbo].[Pedidos]** (5 items)

- **columnName**: PedidoId | **dataType**: int | **maxLength**: 4 | **precision**: 10 | **scale**: 0 | **isNullable**: false | **isPrimaryKey**: 1 | **isForeignKey**: 0 | **isIdentity**: true | **isComputed**: false | **defaultValue**: _NULL_ | **description**: _NULL_
- **columnName**: ClienteId | **dataType**: int | **maxLength**: 4 | **precision**: 10 | **scale**: 0 | **isNullable**: false | **isPrimaryKey**: 0 | **isForeignKey**: 1 | **isIdentity**: false | **isComputed**: false | **defaultValue**: _NULL_ | **description**: _NULL_
- **columnName**: FechaPedido | **dataType**: datetime2 | **maxLength**: 6 | **precision**: 19 | **scale**: 0 | **isNullable**: false | **isPrimaryKey**: 0 | **isForeignKey**: 0 | **isIdentity**: false | **isComputed**: false | **defaultValue**: (sysdatetime()) | **description**: _NULL_
- **columnName**: Estado | **dataType**: varchar | **maxLength**: 20 | **precision**: 0 | **scale**: 0 | **isNullable**: false | **isPrimaryKey**: 0 | **isForeignKey**: 0 | **isIdentity**: false | **isComputed**: false | **defaultValue**: ('PENDIENTE') | **description**: _NULL_
- **columnName**: Total | **dataType**: decimal | **maxLength**: 9 | **precision**: 12 | **scale**: 2 | **isNullable**: false | **isPrimaryKey**: 0 | **isForeignKey**: 0 | **isIdentity**: false | **isComputed**: false | **defaultValue**: ((0)) | **description**: _NULL_
```

El LLM lo resume: `PedidoId` es identidad y PK, `ClienteId` es la FK hacia `Clientes`, y
`FechaPedido` toma la fecha del servidor por defecto.

### 2. Datos — una consulta de negocio

**Tú:** «¿Quiénes son los 5 clientes que más compraron en 2026?»

**El LLM llama a** `execute_select_query` (solo admite `SELECT`/`WITH`):

```json
{
  "database": "TiendaDemo",
  "query": "SELECT TOP 5 c.ClienteId, c.Nombre, COUNT(*) AS Pedidos, SUM(p.Total) AS TotalComprado FROM dbo.Clientes c INNER JOIN dbo.Pedidos p ON p.ClienteId = c.ClienteId WHERE p.FechaPedido >= '2026-01-01' AND p.FechaPedido < '2027-01-01' GROUP BY c.ClienteId, c.Nombre ORDER BY TotalComprado DESC"
}
```

**Salida** — ejemplo ilustrativo (datos ficticios):

```text
**Query Results** (5 rows, 38ms)

| ClienteId | Nombre | Pedidos | TotalComprado |
| --- | --- | --- | --- |
| 1207 | Cliente Demo 1207 | 41 | 18240.75 |
| 88 | Cliente Demo 0088 | 36 | 15112.4 |
| 3415 | Cliente Demo 3415 | 29 | 12980.15 |
| 502 | Cliente Demo 0502 | 33 | 11745.9 |
| 2760 | Cliente Demo 2760 | 18 | 10033.25 |
```

> El validador rechaza cualquier consulta con `--`, `/*` o `*/`, aunque el resto sea un `SELECT`
> válido. Por eso el LLM escribe el SQL sin comentarios y explica la intención en el mensaje.

### 3. Consulta — ¿por qué esta consulta lee tanto?

**Tú:** «Revisa el plan de esta consulta, la usa el informe de envíos y tarda mucho:
`SELECT PedidoId, Total FROM dbo.Pedidos WHERE YEAR(FechaPedido) = 2026 AND Estado = 'ENVIADO'`»

**El LLM llama a** `explain_query` (plan estimado: valida que sea un `SELECT`/`WITH` y activa
`SHOWPLAN_TEXT` en su propio lote, así que la consulta no se ejecuta):

```json
{
  "database": "TiendaDemo",
  "query": "SELECT PedidoId, Total FROM dbo.Pedidos WHERE YEAR(FechaPedido) = 2026 AND Estado = 'ENVIADO'"
}
```

**Salida** — ejemplo ilustrativo (datos ficticios):

````text
**Estimated Execution Plan**

```
SELECT PedidoId, Total FROM dbo.Pedidos WHERE YEAR(FechaPedido) = 2026 AND Estado = 'ENVIADO'
  |--Clustered Index Scan(OBJECT:([TiendaDemo].[dbo].[Pedidos].[PK_Pedidos]), WHERE:(datepart(year,[TiendaDemo].[dbo].[Pedidos].[FechaPedido])=(2026) AND [TiendaDemo].[dbo].[Pedidos].[Estado]='ENVIADO'))
```
````

El LLM señala el problema: `YEAR(FechaPedido)` envuelve la columna en una función, así que el
predicado no es sargable y el motor recorre la tabla entera. Propone el rango equivalente
`FechaPedido >= '2026-01-01' AND FechaPedido < '2027-01-01'`, que puede usar un índice sobre
`FechaPedido`, y vuelve a pedir el plan para comprobarlo.

### 4. Rendimiento — «la tienda va lenta»

**Tú:** «Los usuarios dicen que la tienda va lenta. ¿El servidor está esperando o trabajando?»

**El LLM llama a** `get_performance_triage` (mide una ventana en vivo; tarda lo que dure la
muestra):

```json
{
  "sampleSeconds": 30
}
```

**Salida** — ejemplo ilustrativo (datos ficticios):

```text
# Performance Triage

Measured window: **30s** · 8 cores · total wait recorded: **52800 ms**

## Verdict

🔴 **The server spends significant time waiting** — roughly 22.0% of available core time in the window. Leading contributor: Disk I/O (60%). This is where the investigation goes.

## Where the time went

| Family | Wait ms | % of window | Top wait type |
| --- | ---: | ---: | --- |
| Disk I/O | 31680 | 60% | PAGEIOLATCH_SH |
| Parallelism | 13200 | 25% | CXPACKET |
| CPU pressure | 5280 | 10% | SOS_SCHEDULER_YIELD |
| Other | 2640 | 5% | MEMORY_ALLOCATION_EXT |

**Disk I/O dominates.** Time is going into reading or writing storage: either the queries read far more than they need, or the storage is slow.

**Next step:** `get_query_stats` sorted by logical reads, then `get_missing_indexes`. Fix the reads before blaming the disk.

## Live state

- Sessions blocked at start / end of window: **0** / **0**
- Running requests at start / end: 6 / 7
- Longest running request: 4210 ms — `SELECT` (running) by app_tiendademo

---

ℹ️ This measures a live window, so it only sees what happened during it. A quiet sample does not mean a healthy server — it means nothing was struggling *just now*. For problems that already happened, use `get_blocking_history` or Query Store.

ℹ️ Waiting is not automatically bad: a server doing nothing also waits for nothing. Read these numbers against whether users are actually complaining.
```

No hay bloqueos y la espera dominante es de lectura de disco, así que el siguiente paso es
buscar las consultas que más leen. Eso es el flujo de auditoría del final de esta sección.

### 5. Integridad — registros huérfanos

**Tú:** «¿Hay líneas de pedido que apunten a pedidos o productos que ya no existen?»

**El LLM llama a** `check_referential_integrity`, limitado a una tabla:

```json
{
  "database": "TiendaDemo",
  "table": "DetallePedidos"
}
```

**Salida** — ejemplo ilustrativo (datos ficticios):

```text
**⚠️ Referential Integrity Violations (1 FKs with orphans)** (1 items)

| fkName | parentTable | parentColumn | referencedTable | referencedColumn | orphanedRecords |
| --- | --- | --- | --- | --- | --- |
| FK_DetallePedidos_Productos | dbo.DetallePedidos | ProductoId | dbo.Productos | ProductoId | 14 |
```

Si una FK está activa y es de confianza, no puede haber huérfanos; que aparezcan indica que la
restricción se creó o se reactivó `WITH NOCHECK`, o que estuvo deshabilitada mientras se
borraban productos. El LLM puede listar las 14 filas con `execute_select_query` antes de decidir
qué hacer con ellas.

### Flujo de auditoría de rendimiento

Un caso típico encadena cuatro tools. Cada paso usa la salida del anterior para decidir el
siguiente; el propio triage ya sugiere por dónde seguir.

**Tú:** «Desde las 10 de la mañana la tienda va lenta. Averigua por qué y propón un arreglo.»

**Paso 1 — `get_performance_triage`.** ¿Espera o trabaja?

```json
{
  "sampleSeconds": 30
}
```

Resultado: el del ejemplo 4. Sin bloqueos; la familia *Disk I/O* acapara el 60 % de la espera y
el veredicto apunta a las consultas que más leen.

**Paso 2 — `get_query_stats`.** ¿Qué consultas leen más?

```json
{
  "sortBy": "reads",
  "top": 5
}
```

Salida, recortada a la primera consulta — ejemplo ilustrativo (datos ficticios):

```text
**Top Queries by READS** (5 items)

- **databaseName**: TiendaDemo | **queryText**: SELECT PedidoId, Cantidad, PrecioUnitario FROM dbo.DetallePedidos WHERE ProductoId = @ProductoId | **executions**: 18450 | **totalCpuMs**: 405900 | **avgCpuMs**: 22 | **totalDurationMs**: 553500 | **avgDurationMs**: 30 | **totalReads**: 1291500000 | **avgReads**: 70000 | **totalWrites**: 0 | **planCreated**: 2026-10-26T09:58:12.403Z | **lastExecution**: 2026-10-26T11:41:07.950Z
```

Una consulta sencilla lee 70 000 páginas en cada ejecución y se ejecuta miles de veces.

**Paso 3 — `explain_query`.** ¿Por qué lee tanto?

```json
{
  "database": "TiendaDemo",
  "query": "SELECT PedidoId, Cantidad, PrecioUnitario FROM dbo.DetallePedidos WHERE ProductoId = 1042"
}
```

Salida — ejemplo ilustrativo (datos ficticios):

````text
**Estimated Execution Plan**

```
SELECT PedidoId, Cantidad, PrecioUnitario FROM dbo.DetallePedidos WHERE ProductoId = 1042
  |--Clustered Index Scan(OBJECT:([TiendaDemo].[dbo].[DetallePedidos].[PK_DetallePedidos]), WHERE:([TiendaDemo].[dbo].[DetallePedidos].[ProductoId]=(1042)))
```
````

No hay índice que empiece por `ProductoId`: cada búsqueda recorre la tabla completa.

**Paso 4 — `get_missing_indexes`.** ¿Lo confirma el optimizador?

```json
{
  "database": "TiendaDemo"
}
```

Salida — ejemplo ilustrativo (datos ficticios):

```text
**Missing Indexes (Recommended) — [TiendaDemo]** (1 items)

- **schema**: dbo | **tableName**: DetallePedidos | **equalityColumns**: [ProductoId] | **inequalityColumns**: _NULL_ | **includedColumns**: [PedidoId], [Cantidad], [PrecioUnitario] | **estimatedImprovement**: 18727488 | **seeks**: 18450 | **scans**: 0 | **avgCost**: 10.4 | **avgImpactPct**: 97.6
```

**Conclusión del LLM:** la lentitud viene de lecturas, no del hardware. Propone un índice sobre
`dbo.DetallePedidos (ProductoId)` que incluya `PedidoId`, `Cantidad` y `PrecioUnitario`, y lo
deja como **propuesta** para que una persona la revise: antes de crearlo conviene mirar
`list_indexes` y `get_index_usage_stats` para no duplicar un índice existente.

---

## 📚 Resources

| Resource         | URI                                 | Descripción                       |
| ---------------- | ----------------------------------- | --------------------------------- |
| Server Info      | `sqlserver://server-info`           | Versión, edición, memoria, uptime |
| Database Diagram | `sqlserver://database-diagram/{db}` | ERD en formato Mermaid            |

---

## ⚙️ Variables de Entorno

| Variable                         | Default     | Descripción                  |
| -------------------------------- | ----------- | ---------------------------- |
| `MSSQL_HOST`                     | (requerido) | Host del SQL Server          |
| `MSSQL_PORT`                     | `1433`      | Puerto                       |
| `MSSQL_USER`                     | (requerido) | Usuario SQL                  |
| `MSSQL_PASSWORD`                 | (requerido) | Contraseña                   |
| `MSSQL_DATABASE`                 | `master`    | Base de datos por defecto    |
| `MSSQL_ENCRYPT`                  | `true`      | Encriptar conexión. Solo `false` explícito la desactiva |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | `false`     | Aceptar el certificado sin validarlo. Solo `true` explícito lo activa |
| `MSSQL_READ_ONLY`                | `true`      | Modo solo lectura. Solo `false` explícito lo desactiva |
| `MSSQL_AUDIT_LOG`                | `true`      | Bitácora de auditoría en stderr. Solo `false` explícito la desactiva |
| `MSSQL_MAX_ROWS`                 | `1000`      | Máximo de filas por consulta |
| `MSSQL_QUERY_TIMEOUT`            | `30000`     | Timeout de queries (ms)      |
| `MSSQL_CONNECTION_TIMEOUT`       | `15000`     | Timeout de conexión (ms)     |
| `MSSQL_POOL_MIN`                 | `1`         | Conexiones mínimas del pool  |
| `MSSQL_POOL_MAX`                 | `10`        | Conexiones máximas del pool  |

Las tres banderas de seguridad **fallan en cerrado** y no distinguen mayúsculas: un valor vacío,
`1`, `yes` o una errata dejan el modo seguro activo. `MSSQL_TRUST_SERVER_CERTIFICATE` pasó a `false`
por defecto: si tu servidor usa un certificado autofirmado (típico en desarrollo o en el contenedor
de `docker-compose`), ponlo a `true` de forma explícita en tu `.env`.

---

## 🔒 Seguridad

- **Solo lectura por defecto, en varias capas**: `MSSQL_READ_ONLY` falla en cerrado; las tools que
  reciben SQL o filtros pasan por el validador (una sola sentencia `SELECT`/`WITH`, sin DML, DDL,
  `EXEC`, `DECLARE` ni control de transacciones) y se ejecutan dentro de una transacción que
  siempre se revierte. Ninguna de estas capas sustituye al login: **el control real es un login
  de mínimo privilegio** (ver abajo). Con `sa`, un error en el filtro equivale a control total.
- **`explain_query` y `validate_query` no ejecutan la consulta**: la validan primero y activan
  `SHOWPLAN_TEXT` / `PARSEONLY` en su propio lote, sobre una conexión dedicada que se cierra al
  terminar.
- **Sin SQL libre en `read_table_data`**: los filtros son estructurados y los valores viajan como
  parámetros.
- **Validación de argumentos**: cada llamada se valida contra el esquema de la tool antes de
  ejecutarse (numéricos acotados, claves desconocidas rechazadas). Los fallos llegan al cliente
  con `isError: true`.
- **Sanitización de identificadores**: lista blanca única; un nombre inválido se rechaza, nunca
  se recorta en silencio.
- **Bitácora de auditoría**: una línea JSON por llamada y por sentencia en stderr, con tool, base,
  SHA-256 del SQL (no el SQL) y filas devueltas. Se desactiva con `MSSQL_AUDIT_LOG=false`.
- **Timeouts configurables** y **límite de filas**.

El recorrido completo de una consulta (registro `callTool`, validación zod de argumentos, `sql-sanitizer` de una sola sentencia, `MSSQL_READ_ONLY`, transacción con `ROLLBACK` forzado o conexión dedicada con `SHOWPLAN`/`PARSEONLY` en lotes separados, respuesta con `isError` y bitácora de auditoría en stderr) está en el diagrama [Flujo de una consulta](assets/diagramas/flujo-consulta.html) ([SVG](assets/diagramas/flujo-consulta.svg)).

### Login de mínimo privilegio

El filtro de texto del servidor y la transacción con rollback son **defensa en profundidad**.
El control que de verdad limita lo que el LLM puede hacer es **el login SQL** con el que se conecta
el MCP. Usa siempre un login dedicado de solo lectura, **nunca `sa`** ni un miembro de `sysadmin`
o `db_owner`:

```sql
CREATE LOGIN mcp_reader WITH PASSWORD = '<contraseña-larga-y-única>', CHECK_POLICY = ON;
GRANT VIEW SERVER STATE TO mcp_reader;          -- DMVs de instancia (rendimiento, bloqueos)
GRANT VIEW ANY DEFINITION TO mcp_reader;        -- opcional: definiciones de objetos en todas las bases

-- En cada base que el MCP deba leer:
USE [MiBase];
CREATE USER mcp_reader FOR LOGIN mcp_reader;
ALTER ROLE db_datareader ADD MEMBER mcp_reader;
GRANT VIEW DATABASE STATE TO mcp_reader;        -- DMVs de base (índices, estadísticas, Query Store)
```

En SQL Server 2022 o superior, `VIEW SERVER PERFORMANCE STATE` y `VIEW DATABASE PERFORMANCE STATE`
son alternativas más acotadas. Si una tool necesita un permiso que el login no tiene, falla con un
error de permisos: es el comportamiento esperado.

Qué hace el servidor además del login:

- `execute_select_query`, `read_table_data`, `search_data`, `get_table_sample` y la ruta de lectura
  de `execute_query` se ejecutan
  dentro de una transacción que **siempre** se revierte (`BEGIN TRAN … ROLLBACK`). Si algo evade el
  validador de texto, el motor deshace el DML. No deshace efectos fuera de la transacción
  (secuencias, valores de identidad, procedimientos extendidos, llamadas a servidores vinculados).
- `MSSQL_READ_ONLY` falla en cerrado: solo `false` explícito habilita la escritura, y aun así cada
  llamada a `execute_query` tiene que pedirla con `allowWrite: true`.

---

## 🐳 Docker

```bash
docker build -t mcp-sqlserver .
docker run --rm -i \
  -e MSSQL_HOST=host.docker.internal \
  -e MSSQL_USER=mcp_reader \
  -e MSSQL_PASSWORD="$MSSQL_PASSWORD" \
  mcp-sqlserver
```

> **El flag `-i` es obligatorio.** El servidor habla MCP por STDIO: sin stdin abierto lee EOF y se
> cierra inmediatamente. La imagen no incluye el `.env` (no se copia al contexto de build), así que
> las credenciales se pasan siempre con `-e`. La imagen usa Node 22 LTS y corre como el usuario
> sin privilegios `node`.

### Entorno completo de pruebas

Si no tienes un SQL Server a mano, el `docker-compose.yml` levanta uno de desarrollo
(SQL Server 2022 Developer, con healthcheck) y el servidor MCP ya conectado contra él:

```bash
docker compose up --build
```

La contraseña `sa` del contenedor de pruebas **no está en el compose**: se lee de
`MSSQL_SA_PASSWORD` en tu `.env` local (no versionado; ver `.env.example`), y `docker compose`
se niega a arrancar si falta. El puerto 1433 se publica solo en `127.0.0.1`. El servicio
`mcp-server` declara `stdin_open: true` por la misma razón que el `-i` de arriba.

### Pruebas de integración

`npm run test:integration` ejecuta `tests/integration/` contra un SQL Server **real y desechable**:
el servicio `sqlserver` de este mismo `docker-compose.yml`. Es un script aparte; `npm test` no lo
incluye y sigue sin necesitar base de datos.

```bash
# 1. Una contraseña SA de un solo uso (no la guardes en el repo)
export MSSQL_SA_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url')+'aA1!')")"

# 2. El contenedor (espera al healthcheck)
docker compose up -d --wait sqlserver

# 3. La suite (lee MSSQL_SA_PASSWORD del entorno)
npm run test:integration

# 4. Al terminar
docker compose down -v
```

Si ya tenías el contenedor del compose con su volumen, la contraseña SA es la que se fijó la
primera vez (una nueva no la cambia y el healthcheck fallará): reutiliza esa y **no** uses `-v`
al bajarlo, que borra el volumen con tus bases de desarrollo. La suite limpia lo suyo sola.
En PowerShell, el paso 1 es `$env:MSSQL_SA_PASSWORD = "<contraseña>"`.

| Variable                  | Por defecto | Uso                                                              |
| ------------------------- | ----------- | ---------------------------------------------------------------- |
| `MSSQL_IT_ADMIN_PASSWORD` | —           | Contraseña SA del contenedor (o `MSSQL_SA_PASSWORD`). Obligatoria |
| `MSSQL_IT_ADMIN_USER`     | `sa`        | Login que crea y borra la base y los logins de la prueba          |
| `MSSQL_IT_HOST`           | `127.0.0.1` | Solo `localhost`, `127.0.0.1` o `::1`                            |
| `MSSQL_IT_PORT`           | `1433`      | Si mueves el puerto con `MSSQL_HOST_PORT` en el compose           |

**Nunca corre contra una instancia real.** La suite no lee `.env` ni `MSSQL_HOST` (en una máquina
de desarrollo apuntan a instancias reales) y tiene dos comprobaciones sin bypass, en
`tests/integration/guard.ts`:

1. **Antes de conectar**: el host tiene que ser literalmente de loopback. Nombres que resuelven a
   loopback, rangos privados o túneles se rechazan.
2. **Después de conectar y antes de cualquier DDL**: `SERVERPROPERTY('MachineName')` tiene que ser
   `mcp-sqlserver-test` (el `hostname:` del servicio en el compose), en Linux y edición Developer o
   Express. Otro contenedor local que escuche en loopback también se rechaza.

Si falta una variable o falla una comprobación, la ejecución **falla**; no se salta.

**Qué crea y qué borra.** Por ejecución, una base `mcp_it_<aleatorio>` con datos semilla sintéticos
y dos logins con contraseñas generadas al vuelo (no se escriben en ningún sitio):

- `mcp_it_reader_<aleatorio>`: solo `db_datareader`. Todas las tools se prueban con este login.
- `mcp_it_writer_<aleatorio>`: `SELECT` y `UPDATE` sobre una sola tabla. Lo usa únicamente la
  prueba que demuestra que el rollback forzado deshace una escritura que se colara.

Al terminar se borran esos tres nombres exactos, nunca por patrón.

**Qué cubre.**

| Archivo                   | Comprueba                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `integrity-tools.test.ts` | `validate_data_types`, `check_null_analysis` y `check_referential_integrity` con columnas que llevan `]` en el nombre |
| `read-only.test.ts`       | Escrituras rechazadas antes de llegar al servidor, lectura dentro de una transacción, y que el login de lectura no puede escribir aunque se salte el filtro |
| `rollback.test.ts`        | La transacción de lectura revierte una escritura, también si el lote falla después          |
| `max-rows.test.ts`        | `MSSQL_MAX_ROWS` se aplica en el servidor (el driver recibe `maxRows + 1` filas) y no se filtra a la siguiente consulta |
| `isolation-level.test.ts` | `SERIALIZABLE`, `REPEATABLE READ`, `HOLDLOCK` y compañía rechazados; los niveles permitidos se aplican de verdad |

En CI corre como el job `integration` de `.github/workflows/ci.yml`, con una contraseña SA
generada y enmascarada en cada ejecución.

---

## 🔧 Troubleshooting

**El cliente MCP dice `Connection closed` / `CONNECTION_CLOSED` y nada más.**

Ningún cliente MCP muestra el stderr del servidor: si el proceso muere antes del handshake, todo
lo que verás es que la conexión se cerró. Para ver el error real, lanza a mano el mismo comando que
tiene configurado el cliente:

```bash
npx tsx src/index.ts      # si usas la variante sin compilar
node dist/index.js        # si compilaste con npm run build
```

Un arranque correcto imprime por stderr el host, la base, los flags y la ruta del `.env`, y termina
con `✅ MCP Server connected and ready`. Las causas habituales:

| Síntoma al ejecutarlo a mano                           | Causa                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`   | Falta `node_modules/` → `npm install`                                    |
| `Cannot find module '.../dist/index.js'`               | No se compiló → `npm run build`, o cambia la config a la variante `tsx`  |
| `Configuration validation failed: host is required`    | El `.env` no se está encontrando, o falta la variable                    |
| Arranca bien pero las tools fallan al consultar        | El servidor arranca sin conectar (el pool es diferido): revisa red, credenciales y firewall del puerto 1433 |

Tras corregirlo hay que **reiniciar el cliente MCP** para que vuelva a lanzar el proceso.

**Comprobar el handshake completo** sin depender de ningún cliente:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx tsx src/index.ts 2>/dev/null
```

Debe devolver el `serverInfo` y el catálogo de tools en JSON.

**Una query válida es rechazada con "Only SELECT and WITH (CTE) queries are allowed".**
El validador de `src/utils/sql-sanitizer.ts` rechaza cualquier consulta que contenga `--`, `/*` o
`*/` **en cualquier posición**, y ciertas palabras vetadas (`SHUTDOWN`, `WAITFOR DELAY`,
`OPENROWSET`, `BULK INSERT`, `xp_cmdshell`) incluso dentro de literales de cadena. Escribe las
consultas sin comentarios.

---

## 🏗️ Desarrollo

```bash
npm install              # Instalar dependencias
npm run build            # Compilar TypeScript (tsup)
npm run dev              # Desarrollo con hot reload (tsx watch)
npm run lint             # Verificar tipos (tsc --noEmit)
npm test                 # Ejecutar tests unitarios (vitest, sin SQL Server)
npm run test:integration # Tests contra el SQL Server desechable del compose (ver Docker)
npm run validate:skills  # Consistencia de .claude/skills/
```

> **Nota**: `npm test` no necesita SQL Server: cubre el sanitizador, la configuración y la capa de
> conexión con `mssql` simulado. Lo que depende del motor lo cubre `npm run test:integration`
> contra el contenedor desechable (ver [Pruebas de integración](#pruebas-de-integración)).

Cada pull request pasa por GitHub Actions (`.github/workflows/ci.yml`): `lint`, `test`, `build` y
`npm audit --omit=dev --audit-level=high` sobre Node 22, y en un job aparte (`integration`) la suite
de integración contra el contenedor del compose.

Para lanzar una tool suelta sin cliente MCP, `src/direct-call.ts` reutiliza el mismo `.env` y pasa
por el mismo `callTool()` que el servidor, con las mismas validaciones:

```bash
npx tsx src/direct-call.ts execute_select_query '{"database":"master","query":"SELECT @@VERSION AS version"}'
npx tsx src/direct-call.ts wait_stats '{"top":10}'
```

Sin argumentos lista las tools disponibles. El antiguo `run-query.mjs`, que ejecutaba SQL sin pasar
por el validador, se retiró.

## 📄 Licencia

MIT
