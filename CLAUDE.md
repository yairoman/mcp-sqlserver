# CLAUDE.md

## Propósito

Este repositorio tiene dos caras, y conviene no confundirlas:

1. **El servidor MCP** (`src/`) — la herramienta que expone SQL Server a un LLM.
   Setup, variables de entorno y catálogo de las 29 tools: ver [`README.md`](README.md).

2. **El espacio de trabajo de auditoría** (`docs/`) — uno de los objetivos centrales del
   proyecto es **usar** ese servidor para revisar el rendimiento de instancias SQL Server:
   analizar bloqueos y contención, diagnosticar consultas y procedimientos lentos,
   identificar malas prácticas de T-SQL, y proponer optimizaciones y reescrituras.
   Los resultados de ese trabajo viven en `docs/`, una carpeta por investigación.

Si te piden analizar rendimiento, bloqueos, índices, un procedimiento concreto o
malas prácticas, estás en el caso 2. Eso no es trabajo lateral: es el objetivo del proyecto.
Qué skill aplica depende de si hay entregable — ver la sección de skills, más abajo.

## Restricciones del validador de queries

`src/utils/sql-sanitizer.ts` filtra las consultas antes de enviarlas. Tres reglas que
producen rechazos poco intuitivos:

1. **Sin comentarios.** `DANGEROUS_PATTERNS` incluye `/--/g`, `/\/\*/g` y `/\*\//g`, así que
   `execute_select_query` rechaza la consulta si contiene `--`, `/*` o `*/` **en cualquier
   posición** — no solo al inicio. Error: *"Only SELECT and WITH (CTE) queries are allowed"*.

2. **Debe empezar por `SELECT`, `WITH` o `SET`** (solo `NOCOUNT`, `TRANSACTION ISOLATION`,
   `ANSI_NULLS`, `QUOTED_IDENTIFIER`, `STATISTICS`, `SHOWPLAN`). Un comentario inicial rompe
   esta comprobación, incluso si el resto es un `SELECT` válido.

3. **Palabras vetadas dentro de literales de cadena.** `validateQuerySafety` busca por
   subcadena, sin distinguir código de datos. `SHUTDOWN`, `WAITFOR DELAY`, `OPENROWSET`,
   `OPENDATASOURCE`, `BULK INSERT` y `xp_cmdshell` disparan el rechazo aunque aparezcan
   entrecomillados. Filtrar `sys.dm_os_wait_stats` excluyendo `'QDS_SHUTDOWN_QUEUE'` falla
   por esto: usar `get_wait_stats` en su lugar.

Escribe las consultas sin comentarios y explica su intención en el mensaje, no en el SQL.

## `docs/` es local, no se versiona

`docs/` está en `.gitignore`: contiene informes con nombres de objetos, volúmenes y
estructura de bases productivas de clientes. No lo agregues al índice ni propongas
commitearlo.

Sí se versionan los skills del proyecto (`.claude/skills/`).

## Análisis de base de datos — dos skills que se complementan

| Skill | Aporta |
|---|---|
| [`buenas-practicas-sql`](.claude/skills/buenas-practicas-sql/SKILL.md) | El **criterio técnico**: anti-patrones, cómo detectarlos, por qué importan y cuál es el arreglo |
| [`analisis-bd`](.claude/skills/analisis-bd/SKILL.md) | El **proceso**: dónde vive la documentación, cómo se nombra y qué garantías debe cumplir |

Se activan solos; no hace falta invocarlos a mano.

**El límite entre los dos es si hay entregable.** Una revisión puntual, una pregunta sobre por
qué algo es lento o escribir T-SQL nuevo → solo `buenas-practicas-sql`: responde y para ahí.
`analisis-bd` entra cuando el trabajo va a dejar un archivo que alguien aplique o archive, y
trae consigo carpeta en `docs/`, informe, PDF y scripts numerados. Montar todo eso para una
pregunta de dos minutos es sobre-entrega: si algo merece escalar, dilo y pregunta antes.

Los PDFs de `docs/guias/` son **entregables generados** por análisis previos, no la fuente de
verdad. La autoridad es el skill. Si un criterio cambia, se actualiza el skill; el PDF queda
como el estado que se entregó al cliente en su día.

## Comandos

```bash
npm run build            # tsup
npm run dev              # tsx watch src/index.ts
npm test                 # vitest run
npm run lint             # tsc --noEmit
npm run validate:skills  # consistencia de .claude/skills/ — correr tras editar un skill
```
