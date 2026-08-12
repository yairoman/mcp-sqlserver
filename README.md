# mcp-sqlserver

**MCP Server para SQL Server** — Permite a cualquier LLM (Claude, Copilot, Cursor, etc.) conectarse a SQL Server para inspeccionar esquemas, leer datos, ejecutar queries, analizar performance y validar integridad de información.

## 🚀 Quick Start

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

Copia el archivo de ejemplo y edítalo con tus credenciales:

```bash
cp .env.example .env
```

Edita el `.env` con los datos de tu SQL Server:

```env
# Conexión SQL Server
MSSQL_HOST=tu-servidor          # IP o hostname del server
MSSQL_PORT=1433                 # Puerto (default: 1433)
MSSQL_USER=tu-usuario           # Usuario SQL
MSSQL_PASSWORD=tu-password      # Contraseña
MSSQL_DATABASE=master           # Base de datos inicial

# Seguridad
MSSQL_ENCRYPT=false             # true si usas SSL/TLS, false para conexiones locales
MSSQL_TRUST_SERVER_CERTIFICATE=false  # true para aceptar certificados auto-firmados
MSSQL_READ_ONLY=true            # true = solo SELECT, false = permite INSERT/UPDATE/DELETE

# Límites
MSSQL_MAX_ROWS=1000             # Máximo de filas por consulta
MSSQL_QUERY_TIMEOUT=30000       # Timeout de queries en ms
MSSQL_CONNECTION_TIMEOUT=15000  # Timeout de conexión en ms

# Pool de conexiones
MSSQL_POOL_MIN=1
MSSQL_POOL_MAX=10
```

> **💡 Nota**: El servidor carga el archivo `.env` automáticamente usando `dotenv`. Si también configuras variables de entorno en tu cliente MCP (Claude, Codex, etc.), las del cliente tienen **prioridad** sobre el `.env`.

### 3. Compilar

```bash
npm run build
```

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

> **Alternativa sin compilar**: Puedes usar `npx` como comando y `tsx /ruta/a/mcp-sqlserver/src/index.ts` como argumento para ejecutar directamente desde TypeScript.

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
| `read_table_data`      | Lee datos de tablas con filtros, paginación y orden |
| `execute_select_query` | Ejecuta SELECT arbitrario (validado como read-only) |
| `search_data`          | Busca valores con LIKE en columnas específicas      |
| `get_table_sample`     | Muestra representativa + estadísticas básicas       |

### ⚡ Query Execution (3)

| Tool             | Descripción                                          |
| ---------------- | ---------------------------------------------------- |
| `execute_query`  | Ejecuta cualquier query T-SQL (read-only/read-write) |
| `explain_query`  | Plan de ejecución estimado                           |
| `validate_query` | Validación de sintaxis sin ejecutar                  |

### 📈 Performance & Monitoring (11)

| Tool                    | Descripción                                       |
| ----------------------- | ------------------------------------------------- |
| `get_index_usage_stats` | Estadísticas de uso de índices                    |
| `get_missing_indexes`   | Índices recomendados por el optimizer             |
| `get_active_sessions`   | Sesiones activas y queries en ejecución           |
| `get_blocking_chains`   | Cadenas de bloqueo **activas en este instante**   |
| `get_blocking_history`  | Bloqueos **pasados** (Query Store): quién esperó, cuánto y si se abortó |
| `get_wait_stats`        | Esperas del servidor — acumuladas, o **medidas en una ventana** con `sampleSeconds` |
| `get_performance_triage` | Mide, clasifica y **dictamina**: ¿el servidor espera o trabaja, y en qué? |
| `get_table_statistics`  | Estadísticas de columnas y frescura               |
| `get_query_stats`       | Top queries por CPU/duración/lecturas             |
| `get_configuration_health` | Audita la configuración del motor y **emite un juicio**: qué está mal, qué debería ser y por qué |
| `get_compatibility_assessment` | Assessment de subida de compat level: prerequisitos, qué mejora solo, qué revisar y plan de aplicación |

> **`get_configuration_health` es la única tool que opina.** Las demás devuelven datos; esta los
> contrasta contra valores conocidos y clasifica cada hallazgo por severidad y por categoría —
> *Estabilidad*, *Diagnosticabilidad*, *Rendimiento*, *Integridad*—, que es lo que dice qué
> arreglar primero. Comprueba memoria, MAXDOP, umbral de paralelismo, archivos de tempdb, compat
> level **contra la versión real del motor**, RCSI, `auto_shrink`/`auto_close`/`page_verify`,
> retención de Change Tracking, estado de Query Store y si los bloqueos son diagnosticables.
> Audita **cómo está configurado** el motor, no cómo está escrito el código: una función escalar
> que quema horas de CPU no aparece aquí. El criterio sale de R-25 del skill
> `buenas-practicas-sql`, derivado de auditorías reales.

> **`get_compatibility_assessment` responde «¿qué pasa si subo el compat level?»** Sin
> `targetLevel` asume el máximo que soporta el motor; sin `database`, resume cuántas bases están
> por detrás y cuántas podrían migrar sin red. Lo que lo hace fiable es que **no adivina**: lee
> `sys.sql_modules.is_inlineable`, o sea la respuesta del propio optimizador sobre qué funciones
> escalares dejarían de ejecutarse fila por fila. En una base medida: 115 de 176 inlineables, y
> las 61 restantes seguirán igual a cualquier nivel — eso separa lo que se arregla solo de lo que
> exige reescritura. Comprueba además Query Store como prerequisito (sin él la subida no es
> reversible en la práctica), planes forzados, plan guides, configuraciones que entran en
> conflicto y frescura de estadísticas.

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
| `MSSQL_ENCRYPT`                  | `true`      | Encriptar conexión           |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | `true`      | Confiar en certificado       |
| `MSSQL_READ_ONLY`                | `true`      | Solo permitir SELECT         |
| `MSSQL_MAX_ROWS`                 | `1000`      | Máximo de filas por consulta |
| `MSSQL_QUERY_TIMEOUT`            | `30000`     | Timeout de queries (ms)      |
| `MSSQL_CONNECTION_TIMEOUT`       | `15000`     | Timeout de conexión (ms)     |
| `MSSQL_POOL_MIN`                 | `1`         | Conexiones mínimas del pool  |
| `MSSQL_POOL_MAX`                 | `10`        | Conexiones máximas del pool  |

---

## 🔒 Seguridad

- **Read-only por defecto**: Solo queries SELECT permitidos
- **Validación de queries**: Detecta patrones peligrosos (DROP, xp_cmdshell, etc.)
- **Sanitización de identificadores**: Previene SQL injection
- **Timeouts configurables**: Previene queries indefinidos
- **Límite de filas**: Previene descarga accidental de tablas enormes

---

## 🐳 Docker

```bash
docker build -t mcp-sqlserver .
docker run --rm \
  -e MSSQL_HOST=host.docker.internal \
  -e MSSQL_USER=sa \
  -e MSSQL_PASSWORD=yourpassword \
  mcp-sqlserver
```

---

## 🏗️ Desarrollo

```bash
npm install       # Instalar dependencias
npm run build     # Compilar TypeScript
npm run dev       # Desarrollo con hot reload
npm run lint      # Verificar tipos
npm test          # Ejecutar tests
```

## 📄 Licencia

MIT
