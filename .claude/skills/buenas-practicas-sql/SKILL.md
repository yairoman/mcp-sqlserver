---
name: buenas-practicas-sql
description: Base de conocimiento viva de buenas prácticas y anti-patrones de T-SQL en SQL Server, derivada de auditorías reales. Se activa al escribir, revisar u optimizar T-SQL; al hacer code review de un procedimiento, función, vista o trigger; al buscar por qué una consulta es lenta; al evaluar sargabilidad, parameter sniffing, conversión implícita, procesamiento fila por fila, NOLOCK, tablas temporales, table variables, funciones escalares, cursores, transacciones o triggers; al revisar índices redundantes, duplicados o faltantes; y al decidir si un patrón sospechoso se puede cambiar sin alterar resultados. Se actualiza al cerrar cada investigación. Aporta el criterio técnico; el proceso de documentar la investigación lo define el skill analisis-bd.
---

# Buenas prácticas T-SQL — base de conocimiento

**35 reglas en 4 niveles.** Ninguna es genérica de manual: cada una salió de un problema real
medido en código productivo —o, en las marcadas `[gen]`, de un mecanismo conocido del motor
que este entorno tiene todas las condiciones para sufrir— con su costo y su consulta de
detección.

Esta base **está viva**: crece al cerrar cada investigación. Ver el protocolo abajo.

| Archivo | Cuándo abrirlo |
|---|---|
| [`references/reglas.md`](references/reglas.md) | El cuerpo. Detalle de cada regla: caso, anti-patrón, forma correcta, detección |
| [`references/checklist-code-review.md`](references/checklist-code-review.md) | Revisar un objeto antes de aprobarlo. Una página, imprimible |
| [`references/registro.md`](references/registro.md) | Ver cómo creció el catálogo, o **añadir** un hallazgo nuevo |
| [`references/validar.mjs`](references/validar.mjs) | Validación de consistencia (`npm run validate:skills`) — paso obligatorio antes de cerrar una versión |

---

## Antes de aplicar nada: el contexto cambia el consejo

Comprueba estos valores. Sin ellos, media guía se aplica mal:

```sql
SELECT compatibility_level, is_read_committed_snapshot_on, snapshot_isolation_state_desc,
       CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS Version,
       CAST(SERVERPROPERTY('Edition') AS varchar(50))        AS Edition
FROM sys.databases WHERE name = DB_NAME();
```

| Hecho | Consecuencia |
|---|---|
| **SQL 2016 / compat 130** | Sin *scalar UDF inlining* (llegó en 2019): cada UDF escalar corre fila por fila y **serializa el plan** |
| **compat < 150** | Sin *table variable deferred compilation*: una table variable estima **1 fila**, siempre |
| **RCSI apagado** | Lectores y escritores se bloquean entre sí. Es la razón de fondo de casi todo `NOLOCK` que encuentres |
| **Standard Edition** | `ONLINE = ON` no está disponible: toda reconstrucción de índice es offline |
| **Always On** | Toda reescritura masiva de datos se mide contra el retraso de *redo* en las réplicas |

---

## Índice de reglas

### Nivel 1 · Órdenes de magnitud — impacto ×100 o más

| # | Regla |
|---|---|
| **R-01** | Nunca envuelvas una columna en una función dentro de `WHERE` o `JOIN` |
| **R-02** | No llames un procedimiento dentro de un bucle fila por fila |
| **R-03** | Los triggers deben ser set-based, siempre — *es pérdida de datos, no lentitud* |
| **R-04** | Transacciones cortas: nunca envuelvan trabajo externo |
| **R-05** | `SELECT ... INTO #temp` en consulta larga bloquea la **instancia** entera |
| **R-06** | Predicados *catch-all*: un plan para todos los parámetros |
| **R-29** | Un identificador sin validar en el `WHERE` de una escritura masiva — *bloqueo y pérdida de datos a la vez* |
| **R-32** | Un predicado que no cubre el prefijo de ninguna clave — *y el paralelismo que lo esconde* |

### Nivel 2 · Corrección — bugs silenciosos, sin síntoma

| # | Regla |
|---|---|
| **R-07** | Comparar con `NULL` usando `=` siempre es falso |
| **R-08** | Nunca generes IDs con `MAX(id) + 1` |
| **R-09** | `NOLOCK` jamás en lecturas que deciden una escritura |
| **R-10** | No abras transacciones con nombre dentro de un trigger o SP anidado |
| **R-11** | Un `CATCH` vacío es un error que nadie verá jamás |
| **R-12** | Determinismo: `TOP` sin `ORDER BY`, variables desde `SELECT` |
| **R-13** | `ORDER BY` en un `SELECT ... INTO #temp` se pierde |
| **R-26** | `SET XACT_ABORT ON` en todo procedimiento con transacciones — *el head blocker dormido* |
| **R-30** | Un filtro nuevo se aplica a **todas** las condiciones hermanas, no solo a la del ticket |
| **R-31** | Una condición que ya es cierta dentro de su propia rama: el bloque que nunca decide |

### Nivel 3 · Diseño y eficiencia

| # | Regla |
|---|---|
| **R-14** | Nada de funciones escalares en un `SELECT` |
| **R-15** | Funciones de tabla: inline, no multi-statement |
| **R-16** | Indexa las tablas temporales grandes según cómo se consultan |
| **R-17** | `UNION` deduplica; usa `UNION ALL` **salvo que necesites lo contrario** |
| **R-18** | No pases parámetros como cadenas «clave=valor» |
| **R-19** | Table variables: estimación fija de 1 fila |
| **R-20** | No unas a un grano más fino que el de la salida |
| **R-21** | Subconsulta correlacionada en el `SELECT` que en realidad es un `EXISTS` |
| **R-22** | Conversión implícita de tipo |
| **R-27** | Orden de acceso consistente entre procedimientos — *deadlocks estructurales* |

### Nivel 4 · Esquema e instancia

| # | Regla |
|---|---|
| **R-23** | Un índice de más también cuesta |
| **R-24** | Ninguna tabla grande debe ser un HEAP, y ninguna bitácora crece sin límite |
| **R-25** | La configuración por defecto de la instancia no es la correcta |
| **R-28** | La instrumentación de diagnóstico también se audita — *el vacío se lee como ausencia* |
| **R-33** | Reducir volumen no es optimizar — *mide quién lee la tabla antes de prometer rendimiento* |
| **R-34** | Una consulta lenta con CPU casi nula no es lenta: está esperando — *y la CPU baja del servidor es el síntoma, no la salud* |
| **R-35** | Una migración de versión mueve los datos, no la puesta a punto — *menos lecturas y más tiempo es la firma* |

---

## Este skill se basta solo

Funciona sin ninguna investigación en curso. Sus tres usos habituales:

| Situación | Qué hacer |
|---|---|
| **Escribir T-SQL nuevo** | Consultar el catálogo en modo preventivo. Es el uso más barato: evita la mala práctica en vez de encontrarla después |
| **Code review** | `references/checklist-code-review.md`, una página |
| **Diagnóstico puntual** — *"¿por qué es lenta esta query?"* | Localizar la regla, dar el hallazgo y el arreglo. **Y parar ahí** |

En el tercer caso, responde y ya: nada de crear carpetas ni informes. El skill `analisis-bd`
—que trae carpeta en `docs/`, informe, PDF y scripts numerados— solo entra cuando el trabajo
produce un **entregable** que alguien va a aplicar o archivar.

### Cuándo sí escalar a `analisis-bd`

Si mientras revisas aparece algo de esto, **dilo y pregunta** antes de montar el paquete:

- Un incidente real de bloqueo o de rendimiento en producción.
- Un defecto de correctitud —R-03, R-07, R-08, R-09, R-13— que ya puede haber corrompido datos.
- El mismo anti-patrón repetido en varios objetos: eso ya no es un bug, es estilo del equipo, y
  se corrige con estándar, no con parches.
- Una reescritura que haya que **verificar** antes de entregar.

---

## Detección vía MCP — qué tool ejecuta cada regla

Este proyecto **es** un servidor MCP de SQL Server; las reglas se comprueban con sus tools, no
copiando SQL a mano. Varias tienen tool dedicada:

| Quieres detectar | Tool del MCP | Regla |
|---|---|---|
| Índices sin uso, redundantes o duplicados | `get_index_usage_stats` + `list_indexes` | R-23 |
| Tipos inconsistentes / conversión implícita | `validate_data_types`; `explain_query` buscando `CONVERT_IMPLICIT` | R-22 |
| Duplicados que multiplicarían un `JOIN` | `find_duplicate_records` — **antes** de convertir una UDF en `LEFT JOIN` | R-14, R-17 |
| Si una columna tiene `NULL` de verdad | `check_null_analysis` — antes de quitar un `ISNULL` o declarar `NOT NULL` | R-01, R-07 |
| Heaps y tablas sin clustered | `get_table_statistics`, `get_row_counts_all_tables` | R-24 |
| Triggers del esquema y su código | `list_triggers` + `get_object_definition` | R-03, R-10 |
| Head blockers y sesiones dormidas | `get_blocking_chains`, `get_active_sessions` | R-26 |
| Cajón de centinelas en una columna de relación, y tablas que escalarían a lock de tabla | `execute_select_query` (`GROUP BY` de la columna; `lock_escalation_desc` en `sys.tables`) | R-29 |
| Si la fuente de diagnóstico aún tiene la evidencia | `execute_select_query` sobre `sys.dm_xe_session_targets` y `sys.fn_xe_file_target_read_file` con `TOP (1)` | R-28 |
| El mismo estado filtrado en unas condiciones del objeto y no en otras | `get_object_definition` y leerlo entero — el diff no basta | R-30 |
| Coste real por sentencia, y si la ausencia de una prueba algo | `get_query_stats`; `execute_select_query` sobre Query Store, comprobando antes `query_capture_mode_desc` | R-28, R-31 |
| Si alguien lee de verdad las tablas que vas a podar — y si el escaneo que ves es tuyo | `execute_select_query` sobre `sys.dm_db_index_usage_stats`, mirando `last_user_scan` contra la hora de tu sesión | R-33 |
| Estadísticas que el restore trajo intactas, y el compat level que se quedó en el motor viejo | `execute_select_query` sobre `sys.dm_db_stats_properties` (`modification_counter` contra `rows`) y `sys.databases` | R-35 |
| Consultas del Object Explorer contaminando un ranking de Query Store | `execute_select_query` filtrando `query_sql_text NOT LIKE '%msparam%'` y separando por `object_id` | R-28 |
| Retención de Change Tracking, por instancia y no por base | `execute_select_query` sobre `sys.change_tracking_databases` | R-25 |
| Señal de contención en tempdb | `get_wait_stats` (`PAGELATCH_EX`, `LATCH_EX`) | R-05 |
| Varianza de duración (max ≫ avg) | `get_query_stats` | R-06 |
| Sentencias que esperan en vez de trabajar (duración ≫ CPU con pocas lecturas) | `execute_select_query` sobre Query Store: `avg_duration` contra `avg_cpu_time` y `avg_logical_io_reads` | R-34 |
| Si la instancia está fechando algo o solo acumulando | `get_wait_stats` **dos veces** y restar; Query Store agregado por día laborable | R-28 |
| FKs no confiables (en observación) | `check_referential_integrity` | registro |
| Plan estimado (scan vs seek) | `explain_query` | R-01 |
| Todo lo demás | `execute_select_query` | — |

> ⚠️ **Al usar `execute_select_query`, quita los comentarios.** Las consultas de detección de
> `reglas.md` llevan `--` para lectura humana, pero el validador de este MCP rechaza cualquier
> query que contenga `--` o `/* */` en cualquier posición, y también palabras vetadas
> (`SHUTDOWN`, `WAITFOR`…) **incluso dentro de literales de cadena**. Ejecuta el SQL limpio y
> explica la intención en el mensaje, no en el código.

---

## Cómo usar el catálogo

**No es una checklist para recitar.** Un hallazgo solo vale si lo respaldas con evidencia
medida en esa base concreta: filas reales, el índice que existe y no se usa, la duración
observada. Un patrón de esta lista sin evidencia es una opinión.

Marcas en `reglas.md`: **[obs]** observado en código auditado — búscalo primero, suele
repetirse entre objetos porque lo escribió el mismo equipo · **[gen]** anti-patrón general aún
no visto aquí.

### Tres reglas que van por encima de las 25

**1. Un patrón "malo" puede ser el que sostiene la correctitud.** Antes de quitarlo, entiende
qué garantiza. El caso canónico es un `UNION` cuya deduplicación alguien estaba usando a
propósito (R-17).

**2. Ningún cambio de conjunto es mecánico.** `UNION` → `UNION ALL`, `JOIN` → `EXISTS`,
`GROUP BY` → `DISTINCT`: todos exigen demostrar con datos que el resultado no cambia.

**3. Si no puedes demostrar la equivalencia, no lo toques.** Entrega parches dirigidos con el
patrón a aplicar, o documenta el hallazgo y déjalo. Una reescritura no verificada es peor que
el código lento que sustituye.

Y una que no es técnica: **lo que decides no corregir se documenta.** Cambiar comportamiento de
negocio no es una decisión técnica.

---

## Protocolo de actualización — esto es lo que la mantiene viva

Al cerrar una investigación, **antes** de darla por terminada:

1. Revisa los hallazgos **confirmados** contra `references/reglas.md`.
2. Clasifica cada uno:
   - **Ya existe y el caso no aporta** → no toques nada.
   - **Ya existe pero el caso revela un sub-caso, una trampa o una consecuencia nueva** →
     refuerza la regla.
   - **No existe** → regla nueva, con el número siguiente, en el nivel que le corresponda.
3. Añade la entrada en `references/registro.md` con fecha y origen anonimizado.
4. Actualiza el índice de arriba y el checklist si procede.
5. **Corre la validación de consistencia y no cierres con fallos:**

   ```
   npm run validate:skills
   ```

   Comprueba frontmatter YAML (un `: ` sin comillas en la descripción desactiva el skill en
   silencio), enlaces, citas `R-xx` contra reglas definidas, reglas huérfanas y el cuadre del
   índice. Lo que **no** comprueba es la anonimización — los nombres a detectar no pueden
   escribirse en un script versionado — así que ese escaneo sigue siendo manual.

**No se promueve al catálogo:** hallazgos no verificados (si no lo mediste, es una sospecha, no
una regla), lo específico de un objeto que no generaliza, ni preferencias de estilo sin costo
medible. Los números **no se reciclan**: una regla retirada se marca como tal y se explica por
qué — eso también es conocimiento.

---

## Política de anonimización — obligatoria

Este skill **se versiona y puede salir de la organización**. El código auditado, no.

**Nunca escribas aquí:**

- Nombres de empresa, cliente, producto o proyecto — incluidos los que aparecen **dentro de
  nombres de objeto** (los índices bautizados con el cliente que pidió la consulta son un caso
  real y el peor, porque parecen inofensivos).
- Nombres reales de base de datos, esquema, tabla, columna, procedimiento, vista, función,
  trigger o índice.
- Identificadores de ticket, incidencia o sprint.
- Nombres de personas: autores, revisores, solicitantes.
- Rutas, servidores, cadenas de conexión, credenciales.

**Sí se conserva** — es lo que da valor y no identifica a nadie:

- Magnitudes: filas, GB, número de índices, porcentaje de esperas, duraciones. Son las que
  justifican la severidad.
- Versión y edición del motor, compat level, configuración de la instancia.
- La forma del anti-patrón y el fragmento de código, **reescrito con nombres genéricos**
  (`dbo.Tabla`, `@lista`, `#Resultado`, `col1`).
- La descripción funcional del objeto: "un trigger de integración", "una vista de permisos",
  "un procedimiento de menú de alta frecuencia".

Los informes con nombres reales viven en `docs/`, que está en `.gitignore` justamente por esto.
Si necesitas trazar una regla hasta su caso concreto, esa correspondencia se queda ahí — nunca
aquí.
