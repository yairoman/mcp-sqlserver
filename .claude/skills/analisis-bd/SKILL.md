---
name: analisis-bd
description: Proceso y entregables de una auditoría de SQL Server. Se activa cuando el trabajo produce un ENTREGABLE que alguien va a aplicar o archivar - auditar el rendimiento de una instancia o de un objeto concreto, documentar un incidente de bloqueo o de rendimiento, preparar scripts de remediación, entregar una reescritura verificada de un procedimiento, o generar el informe y el PDF de cualquiera de esos trabajos. Define dónde vive la documentación, cómo se nombra, cómo se verifica una reescritura y qué garantías debe cumplir antes de entregarse. Para una revisión puntual de código, una pregunta suelta sobre por qué algo es lento, o para escribir T-SQL nuevo, NO aplica — eso lo cubre el skill buenas-practicas-sql por sí solo.
---

# Análisis y documentación de bases de datos SQL Server

Todo trabajo de investigación o rendimiento sobre una base produce **un paquete de
documentación autocontenido**. Este skill define dónde vive, cómo se llama y qué debe
contener antes de considerarse entregable.

---

## Regla 0 — Cuándo NO aplicar este skill

Este skill implica un paquete completo: carpeta en `docs/`, informe HTML y PDF, scripts
numerados con rollback y verificación de equivalencia. **Eso es sobre-entrega si no hay
entregable.**

No lo apliques cuando:

- Te piden **revisar un fragmento** — "¿por qué es lenta esta query?", "échale un ojo a este SP".
- El código **aún no existe** — escribir un procedimiento nuevo.
- Es una **pregunta conceptual** sobre SQL Server o sobre un patrón.
- Piden **una consulta de diagnóstico suelta** para verla ellos mismos.

En esos casos aplica solo `buenas-practicas-sql`: responde con el criterio, el hallazgo y el
arreglo. Sin carpeta, sin informe, sin scripts numerados.

> **Regla práctica:** si al terminar no va a quedar un archivo que alguien pueda aplicar o
> archivar, no es una investigación.

Si a mitad de una revisión ligera aparece algo que sí merece auditoría —un bloqueo real, un
defecto de correctitud, un patrón repetido en varios objetos— **dilo y pregunta antes de
escalar**. No conviertas una pregunta de dos minutos en un paquete de documentación sin que te
lo pidan.

---

## Regla 1 — Una carpeta por investigación

**Cada tarea de investigación o rendimiento genera su propia carpeta bajo `docs/`,
nombrada con el proceso o plan que se está trabajando. Toda la documentación que
produzca esa tarea vive ahí dentro. Sin excepciones.**

```
docs/
  <slug-del-proceso>/
    README.md                      <- índice e itinerario de la carpeta
    analisis-<slug>.html           <- informe
    analisis-<slug>.pdf            <- mismo informe, renderizado
    scripts/
      00_..99_*.sql                <- remediación, numerada, con rollback
```

No escribas en `docs/` a nivel raíz. No mezcles dos investigaciones en una carpeta.
No dejes scripts de una investigación en la carpeta de otra.

### Nombrar la carpeta

`kebab-case`, sin acentos, describiendo **el objeto o el plan**, no la actividad:

| Trabajo | Carpeta |
|---|---|
| Optimizar un procedimiento concreto | `docs/<nombredelprocedimiento>/` |
| Diagnóstico de rendimiento de la instancia | `docs/diagnostico-instancia-2026-07/` |
| Plan de remediación de una base | `docs/remediacion-<nombredelabase>/` |
| Revisar índices de una tabla | `docs/indices-<nombredelatabla>/` |

Los nombres reales de objetos y bases **solo** aparecen dentro de `docs/`, que está en
`.gitignore`. Nunca en los skills, que sí se versionan. Ver la política de anonimización en el
skill `buenas-practicas-sql`.

Si la investigación se repite en el tiempo (un diagnóstico trimestral), añade el periodo
al slug. Si es sobre un objeto concreto, el nombre del objeto **es** el slug.

Cuando arranques una investigación, **crea la carpeta antes de escribir el primer archivo**
y dilo en tu respuesta, para que quede claro dónde va a quedar todo.

---

## Regla 2 — El `README.md` de la carpeta es obligatorio

Es lo primero que abre quien reciba el paquete. Debe responder, en ese orden:

1. **Qué se investigó y por qué** — una línea. Si hubo un incidente, cítalo.
2. **El aviso de estado**: `> **NADA DE ESTO SE HA EJECUTADO.**` seguido del alcance
   real de lo que sí se hizo (p. ej. "toda la sesión de análisis fue solo lectura").
3. **Tabla de archivos** con tipo y nivel de confianza de cada uno.
4. **Orden de ejecución** de los scripts, como bloque de código.
5. **Reglas de aplicación** — las advertencias que pueden romper producción.
6. **Rollback** — cómo se deshace cada cosa.

---

## Regla 3 — Numeración de scripts, reiniciada por carpeta

Cada carpeta es independiente. La numeración **siempre empieza en `00`**, aunque otra
carpeta ya use esos números.

```
00_config_*.sql          cambios de configuración de instancia/base
01_indices_*.sql         altas y bajas de índices
02_vistas_*.sql          reemplazo de vistas
03_triggers_*.sql        reemplazo de triggers
04_funciones_*.sql       reemplazo de UDFs
05_*_v2.sql              reescrituras de stored procedures
10_verificacion_*.sql    prueba de equivalencia v1 vs v2
99_verificacion.sql      consultas de control / línea base
```

Usa solo los que apliquen. Si la investigación produce un único script, sigue siendo
`00_`, no un nombre suelto.

---

## Regla 4 — Garantías que debe cumplir el paquete

Estas no son de estilo. Son las que hacen que alguien pueda aplicar el trabajo sin miedo.

**Análisis en solo lectura.** La investigación se hace con `execute_select_query` y las
herramientas de introspección. Si en algún momento necesitas escribir, para y pregunta.

**Nada se ejecuta.** Los scripts son propuestas. Dilo en la cabecera de cada archivo y en
el README.

**Las reescrituras van en paralelo, nunca sobre el original.** Un SP reescrito se crea como
`<Nombre>_v2`. El cutover es un `sp_rename` comentado al final del script, que deja el
original como `<Nombre>_v1_backup`. Nunca `ALTER PROCEDURE` sobre el objeto productivo.

**Toda reescritura se verifica contra datos reales antes de entregarse.** Reproduce la
lógica v1 y v2 como consultas inline y contrástalas con `EXCEPT` **en las dos direcciones**,
sobre un lote que ejercite cada rama del código (cada parámetro, cada idioma, cada bandera).
Registra el resultado —número de casos, filas y diferencias— en el informe y en la cabecera
del script de verificación. Si no puedes verificarla, entrega parches dirigidos en lugar de
una reescritura, y explica por qué.

Tres límites del método que hay que cubrir aparte:

- **`EXCEPT` aplica `DISTINCT` implícito: no ve la multiplicidad.** `{A,A,B}` vs `{A,B,B}`
  pasa limpio con conteos iguales y `EXCEPT` vacío en ambas direcciones. Cuando los duplicados
  son significativos —o no puedes demostrar que no los hay— compara además los grupos:
  `GROUP BY` de todas las columnas con `COUNT(*)`, y `EXCEPT` entre esos agregados, en las dos
  direcciones.
- **`EXCEPT` no ve el orden.** Si la aplicación depende del orden del result set, se valida
  aparte y se dice en el informe.
- **`EXCEPT` trata `NULL = NULL` como iguales.** Aquí eso es lo deseable para comparar; solo
  tenlo presente si conviertes la comparación a `JOIN`.

**Mapa de dependencias antes del cutover.** Un `sp_rename` con un llamador no identificado es
un incidente en diferido. Antes de proponer el cambio, identifica quién usa el objeto —
`sys.dm_sql_referencing_entities`, `sys.sql_expression_dependencies`, búsqueda en
`msdb.dbo.sysjobsteps`— y lista en el informe los llamadores que **no** pudiste verificar
(aplicación, SSIS, procesos externos).

**Cada `DROP` va precedido de su validación de uso**, comentado, con la consulta de
`sys.dm_db_index_usage_stats` y los días desde el arranque del servidor.

**Cada script termina en una sección `-- ROLLBACK`.**

**Lo que decides NO corregir se documenta.** Si encuentras una inconsistencia funcional,
márcala en el código con una etiqueta (`[N-01]`, `[N-02]`…), explícala en el informe y déjala
tal cual. Cambiar comportamiento de negocio no es una decisión técnica.

**Codificación.** Si un script contiene literales con acentos, guárdalo UTF-8, avísalo en el
README y añade una consulta de control que devuelva `EsCorrecto = 1` tras desplegar.

**Sin datos de personas en los informes.** El informe cita estructura y magnitudes, no filas.
Si una evidencia exige mostrar datos (`get_table_sample`), enmascara identificadores y datos
personales: el PDF circula más allá de la base de datos.

**Procedencia de la evidencia.** Anota en el informe en qué instancia y edición se midió. Si
el destino es otra edición (Developer vs Standard es el caso típico), dilo: cambia qué
operaciones son online y qué costos aplican.

---

## Regla 5 — El informe

Un HTML autocontenido, listo para imprimir, más su PDF. La plantilla completa —CSS,
estructura y galería de componentes— está en
[`references/plantilla-informe.html`](references/plantilla-informe.html). Cópiala y
rellénala; no rediseñes el formato en cada entrega.

Secciones habituales, en este orden:

| # | Sección | Contenido |
|---|---|---|
| — | Masthead + titular + veredicto | El titular es una **afirmación**, no un tema |
| 01 | Perfil | Qué hace el objeto, su estructura en cifras, cómo se midió |
| 02 | El mecanismo | Por qué falla. Tabla mecanismo → cómo se produce → evidencia |
| 03 | Hallazgos | Fichas con severidad, ID (`B-01`…), evidencia y acción |
| 04 | El patrón, en concreto | Bloque de código antes/después del hallazgo principal |
| 05 | Verificación | Resultados reales de la prueba de equivalencia |
| 06 | Esquema | Hallazgos de índices/tablas que están fuera del objeto |
| 07 | Plan de acción | Fases numeradas, cada una con su ventana y su riesgo |

La severidad de cada hallazgo se asigna con criterio fijo, no por sensación:

| Severidad | Criterio |
|---|---|
| **Crítico** | Pérdida o corrupción de datos, resultados incorrectos ya en producción, o un mecanismo de bloqueo con alcance de instancia |
| **Alto** | Orden de magnitud de rendimiento, o riesgo real de incidente bajo carga |
| **Medio** | Costo medible pero acotado; deuda que crece con el volumen |
| **Info / Funcional** | Higiene, o decisión de negocio que no corresponde al técnico (`N-xx`) |

**Cada cifra del informe debe venir de una consulta que ejecutaste.** Nada de rangos
estimados ni de "aproximadamente". Si no lo mediste, no lo publiques; y si una medición no
representa el incidente (caché reciente, pocas ejecuciones), dilo en el propio informe.

### Generar el PDF

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless=new --disable-gpu --no-sandbox `
  --user-data-dir="$env:TEMP\chrome-pdf-profile" `
  --no-pdf-header-footer --virtual-time-budget=8000 `
  --print-to-pdf="<ruta absoluta>.pdf" "file:///<ruta absoluta>.html"
```

`$LASTEXITCODE` queda vacío aunque funcione: verifica con `Test-Path` que el PDF exista y
tenga tamaño.

---

## Regla 6 — Cerrar la investigación es alimentar la base de conocimiento

Una investigación **no está terminada** cuando se entrega el informe. Está terminada cuando lo
aprendido queda disponible para la siguiente.

El criterio técnico —qué es un anti-patrón, cómo detectarlo, por qué importa y cuál es el
arreglo— vive en el skill `buenas-practicas-sql`, que es una base de conocimiento viva. Este
skill define el **proceso**; no dupliques el catálogo aquí.

Antes de dar por cerrado el trabajo:

1. Revisa tus hallazgos **confirmados** contra `buenas-practicas-sql/references/reglas.md`.
2. Los que no estén, o que revelen un sub-caso nuevo de una regla existente, promuévelos:
   regla nueva o refuerzo, más su entrada fechada en `references/registro.md`.
3. **Anonimiza al promover.** Los skills se versionan y pueden salir de la organización; los
   informes de `docs/`, no. Se conservan las magnitudes —son las que justifican la severidad—
   y se eliminan nombres de empresa, cliente, base, esquema, objeto, ticket y persona. La
   política completa está en `buenas-practicas-sql`.
4. No promuevas hallazgos sin verificar. Si no lo mediste, es una sospecha, no una regla.
5. Si tocaste cualquier archivo de los skills, corre la validación de consistencia
   (`npm run validate:skills`) y no cierres con fallos. Detecta, entre otros, el frontmatter
   YAML roto que desactiva un skill en silencio.

Dilo en tu respuesta final: qué reglas añadiste o reforzaste, o que revisaste y no hacía falta.

## Herramientas para reunir la evidencia

| Necesitas | Herramienta |
|---|---|
| Código del objeto | `get_object_definition` |
| Índices, columnas, FKs | `list_indexes`, `describe_table`, `list_foreign_keys` |
| Plan estimado de una consulta | `explain_query` |
| Volumen real | `execute_select_query` sobre `sys.dm_db_partition_stats` |
| Costo por sentencia | `execute_select_query` sobre `sys.dm_exec_query_stats` |
| Historial de planes y regresiones | Query Store, si está activo: `sys.database_query_store_options`, `sys.query_store_plan`, `sys.query_store_runtime_stats` |
| Frescura de estadísticas | `sys.dm_db_stats_properties` (fecha, filas muestreadas, modificaciones) |
| Quién referencia el objeto | `sys.dm_sql_referencing_entities`, `sys.sql_expression_dependencies`, `msdb.dbo.sysjobsteps` |
| Uso real de cada índice | `get_index_usage_stats` — obligatorio antes de proponer un `DROP` |
| Varianza de duración por consulta | `get_query_stats` — mirar el máximo, no solo la media |
| Sesiones vivas y head blockers | `get_active_sessions`, `get_blocking_chains` |
| Contención de la instancia | `get_wait_stats` |
| Índices propuestos por el motor | `get_missing_indexes` |
| NULLs reales de una columna | `check_null_analysis` — antes de quitar un `ISNULL` |
| Duplicados en una clave candidata | `find_duplicate_records` — antes de un `JOIN` nuevo o un índice `UNIQUE` |
| Consistencia de tipos entre tablas | `validate_data_types` |
| Heaps, tamaños y fragmentación | `get_table_statistics` |
| Configuración crítica | `sys.databases`: compat level, **RCSI**, snapshot |

Comprueba siempre RCSI y el compat level antes de razonar sobre bloqueo o sobre
estimaciones de cardinalidad: cambian el diagnóstico por completo.

Si la instancia es 2016+ y Query Store está **apagado**, anótalo como hallazgo de
configuración: es la herramienta nativa para regresiones de plan y su ausencia condiciona
qué se puede diagnosticar a posteriori.

**Al escribir SQL para `execute_select_query`:** sin comentarios (`--` y `/* */` se rechazan en
cualquier posición), empezando por `SELECT`/`WITH`, y sin palabras vetadas ni siquiera en
literales (`SHUTDOWN`, `WAITFOR`…). El mapeo completo regla→tool y el detalle del validador
están en el skill `buenas-practicas-sql`.
