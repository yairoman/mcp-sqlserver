# mcp-sqlserver

**MCP Server para SQL Server** — Permite a cualquier LLM (Claude, Copilot, Cursor, etc.) conectarse a SQL Server para inspeccionar esquemas, leer datos, ejecutar queries, analizar performance y validar integridad de información.

## 📋 Requisitos

- **Node.js >= 20** — verifica con `node -v`
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
MSSQL_USER=tu-usuario           # Usuario SQL
MSSQL_PASSWORD=tu-password      # Contraseña
MSSQL_DATABASE=master           # Base de datos inicial

# Seguridad
MSSQL_ENCRYPT=true              # true si usas SSL/TLS, false para conexiones locales
MSSQL_TRUST_SERVER_CERTIFICATE=true   # true para aceptar certificados auto-firmados
MSSQL_READ_ONLY=true            # true = solo SELECT, false = permite INSERT/UPDATE/DELETE

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
docker run --rm -i \
  -e MSSQL_HOST=host.docker.internal \
  -e MSSQL_USER=sa \
  -e MSSQL_PASSWORD=yourpassword \
  mcp-sqlserver
```

> **El flag `-i` es obligatorio.** El servidor habla MCP por STDIO: sin stdin abierto lee EOF y se
> cierra inmediatamente. La imagen no incluye el `.env` (no se copia al contexto de build), así que
> las credenciales se pasan siempre con `-e`.

### Entorno completo de pruebas

Si no tienes un SQL Server a mano, el `docker-compose.yml` levanta uno de desarrollo
(SQL Server 2022 Developer, con healthcheck) y el servidor MCP ya conectado contra él:

```bash
docker compose up --build
```

Las credenciales del entorno de pruebas están en el propio compose. El servicio `mcp-server`
declara `stdin_open: true` por la misma razón que el `-i` de arriba.

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
npm test                 # Ejecutar tests (vitest)
npm run validate:skills  # Consistencia de .claude/skills/
```

> **Nota**: el proyecto todavía no tiene archivos de test, así que `npm test` termina con
> `No test files found` y código de salida 1. Es lo esperado hoy, no un fallo de instalación.

Para lanzar una consulta suelta contra el servidor sin pasar por el MCP, `run-query.mjs` en la raíz
reutiliza el mismo `.env`:

```bash
node run-query.mjs "SELECT @@VERSION"
```

Sin argumento lista las tablas base de la base configurada. Ojo: `run-query.mjs` ejecuta la
consulta **sin pasar por el validador** de `sql-sanitizer.ts` — es una utilidad de desarrollo, no
una vía de acceso equivalente a las tools.

## 📄 Licencia

MIT
