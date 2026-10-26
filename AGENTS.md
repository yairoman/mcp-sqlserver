# AGENTS.md — Ficha del proyecto mcp-sqlserver

Ficha para agentes y tareas de la fábrica. Léela antes de empezar. Para el detalle de setup,
variables de entorno y catálogo de tools, la fuente es [`README.md`](README.md); para las reglas
de trabajo del repositorio, [`CLAUDE.md`](CLAUDE.md).

> Verificación: esta ficha se escribió en un entorno **sin Node.js ni npm instalados** y sin
> acceso al demonio de Docker. Ningún comando `npm`/`node`/`docker` de esta ficha pudo
> ejecutarse; cada uno lleva su estado. Los comandos `git` sí se ejecutaron.

## Qué es

Servidor MCP (Model Context Protocol) que expone SQL Server a un LLM: introspección de esquema,
lectura de datos, ejecución de consultas, diagnóstico de rendimiento e integridad (33 tools).
El repositorio también es el espacio de trabajo para **auditorías de rendimiento de SQL Server**
usando ese servidor; los informes viven en `docs/`, que no se versiona.

## Stack

- **Lenguaje:** TypeScript (`strict`, ESM: `"type": "module"`), destino `node20`.
- **Runtime:** Node.js `>=20` (`engines` en `package.json`; el `Dockerfile` usa `node:20-alpine`).
- **Dependencias:** `@modelcontextprotocol/sdk` (transporte STDIO), `mssql` (driver y pool),
  `zod` (validación de configuración), `dotenv`.
- **Build:** `tsup` (`tsup.config.ts`: entrada `src/index.ts`, salida `dist/`, ESM, con shebang).
- **Desarrollo:** `tsx` (ejecución directa de TypeScript).
- **Pruebas:** `vitest` (sin archivos de test todavía).
- **Tipos/lint:** `tsc --noEmit`. No hay ESLint ni Prettier configurados.
- **Gestor de paquetes:** npm (`package-lock.json`).
- **Estructura:**
  - `src/index.ts` — entrada: carga `.env`, valida config, arranca el servidor por STDIO.
  - `src/server.ts` — registro de las tools y resources.
  - `src/config.ts` — esquema `zod` de las variables `MSSQL_*`.
  - `src/connection.ts` — pool de `mssql` (diferido: se conecta en la primera consulta).
  - `src/tools/{schema,data,query,performance,integrity}/` — una tool por archivo, cada uno
    exporta `<nombre>Definition` y `<nombre>Handler`.
  - `src/resources/`, `src/utils/` (`sql-sanitizer.ts`, `error-handler.ts`, `result-formatter.ts`),
    `src/types/`.
  - `src/direct-call.ts` — invocador directo de handlers, sin transporte MCP.
  - `run-query.mjs` — utilidad para lanzar una consulta suelta con el mismo `.env`.
  - `.claude/skills/` — skills del proyecto (`buenas-practicas-sql`, `analisis-bd`), versionados.

## Instalar

```bash
npm install
cp .env.example .env     # y editar MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD, ...
npm run build            # genera dist/index.js (opcional si se usa la variante tsx)
```

- `npm install` — **no verificado**: no hay `npm` en el entorno de la fábrica.
- `cp .env.example .env` — no ejecutado a propósito (crearía un archivo local con credenciales).
- `npm run build` — **no verificado**: no hay Node.js en el entorno de la fábrica.

`npm install` es obligatorio incluso para la variante `npx tsx src/index.ts`: sin `node_modules/`
el proceso muere con `ERR_MODULE_NOT_FOUND` y el cliente MCP solo informa `Connection closed`.

## Pruebas

```bash
npm test                 # vitest run
npm run lint             # tsc --noEmit
npm run validate:skills  # consistencia de .claude/skills/ (tras editar un skill)
```

- **Resultado observado:** ninguno. Los tres comandos quedan **no verificados** porque el
  entorno no tiene Node.js/npm (`node: command not found`).
- **Resultado esperado según el README:** el proyecto no tiene archivos de test, así que
  `npm test` termina con `No test files found` y **código de salida 1**. Es el estado actual, no
  un fallo de instalación. Una tarea que añada tests debe contar con esto.
- No existe `vitest.config.*`; vitest usa su configuración por defecto.

## Levantar en local

```bash
npm run dev              # tsx watch src/index.ts (hot reload)
npm start                # node dist/index.js (requiere npm run build)
npx tsx src/index.ts     # sin compilar; es la variante que usa .mcp.json
```

- **Puerto: ninguno.** El servidor habla MCP por **STDIO** (stdout reservado para JSON-RPC, logs
  por stderr); no abre puerto HTTP. Lo lanza un cliente MCP (Claude Code, Claude Desktop, Cursor…).
- Lo único con puerto es SQL Server: `1433` (configurable con `MSSQL_PORT`).
- Arranque correcto: por stderr imprime host, base y flags, y termina con
  `✅ MCP Server connected and ready`.
- Entorno completo con Docker (SQL Server 2022 Developer en `1433` + el servidor MCP):
  `docker compose up --build`. `docker run` necesita `-i` (STDIO).
- Todos estos comandos: **no verificados** (sin Node.js y sin permiso sobre el socket de Docker).
  Además, arrancar de verdad exige un SQL Server accesible y credenciales en `.env`.

## Convenciones

- **Idioma:** README, CLAUDE.md, skills y mensajes de commit en español; código, identificadores
  y comentarios en inglés.
- **Código:** TypeScript estricto (`noUnusedLocals`, `noUnusedParameters`), imports ESM con
  extensión `.js` (`./config.js`), comillas dobles, punto y coma, 2 espacios.
- **Nombres:** archivos en `kebab-case` (`list-tables.ts`); tools en `snake_case`
  (`list_tables`); exports `camelCase` `<tool>Definition` / `<tool>Handler`.
- **Nueva tool:** un archivo en `src/tools/<categoría>/`, registrarlo en `src/server.ts` y
  actualizar el catálogo y el conteo de tools en `README.md` y `CLAUDE.md`.
- **Logs:** siempre a stderr (`console.error`); escribir a stdout rompe el protocolo MCP.
- **Ramas:** `main` es la rama por defecto; el trabajo entra por PR desde ramas con prefijo
  (`feat/…`, `skills/…`). Las tareas de la fábrica usan `odd/T-<n>`.
- **Commits:** frase descriptiva en español, en imperativo o con prefijo de ámbito
  (`README: …`, `Skills: …`); los más recientes usan inglés (`Add …`, `Document …`). No siguen
  Conventional Commits de forma estricta; la fábrica usa Conventional Commits.
- **Skills:** tras editar `.claude/skills/`, correr `npm run validate:skills`. El skill es la
  autoridad; los PDF de `docs/guias/` son entregables generados.

## Zonas delicadas

- **`src/utils/sql-sanitizer.ts`** — barrera de seguridad de las consultas. Rechaza `--`, `/*` y
  `*/` en cualquier posición, exige empezar por `SELECT`/`WITH`/`SET` permitido y veta palabras
  (`SHUTDOWN`, `WAITFOR DELAY`, `OPENROWSET`, `xp_cmdshell`…) incluso dentro de literales.
  Relajarlo abre la puerta a ejecutar código arbitrario en servidores de clientes.
- **`MSSQL_READ_ONLY`** (por defecto `true`) y `src/config.ts` — cambiar valores por defecto
  altera la seguridad de todas las instalaciones.
- **Contrato de las tools** (`name`, `inputSchema` en cada `*Definition`) — lo consumen clientes
  MCP y los skills; renombrar o quitar parámetros rompe a terceros.
- **stdout en `src/index.ts`** — cualquier `console.log` corrompe el canal JSON-RPC.
- **`docs/`** — en `.gitignore`: contiene datos de bases productivas de clientes. Nunca añadirlo
  al índice ni proponer commitearlo. Tampoco `.env`.
- **`run-query.mjs`** — ejecuta SQL **sin pasar por el validador**; es una utilidad de
  desarrollo, no una vía equivalente a las tools.
- **`docker-compose.yml`** — contiene la contraseña `sa` del entorno de pruebas; es solo para
  desarrollo local.
- **`.claude/skills/`** — base de conocimiento versionada con registro y numeración de reglas
  (`R-nn`); editar sin correr `validate:skills` deja referencias inconsistentes.

## Proceso de despliegue

pendiente: lo indica Yair

(El repo solo documenta el uso local, la imagen Docker y la configuración de clientes MCP; no hay
CI, workflows ni proceso de publicación documentado. `package.json` define `prepublishOnly`,
pero no hay indicación de que se publique en npm.)
