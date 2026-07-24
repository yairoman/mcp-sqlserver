# Registro de la base de conocimiento

Bitácora de cómo ha crecido este catálogo. Cada entrada dice **qué se añadió**, **de dónde
salió** y **qué lo motivó**, sin identificar el origen.

Sirve para tres cosas: saber si una regla lleva tiempo validada o es reciente, evitar volver a
añadir lo mismo con otro nombre, y ver qué patrones se repiten entre auditorías — que es la
señal de que son estilo del equipo y no descuidos.

---

## v3 — 2026-07-24 · Revisión de arquitectura de la propia base

**Origen:** revisión del catálogo con criterio de arquitecto de base de datos, sin auditoría
nueva de por medio. Buscaba huecos: mecanismos conocidos del motor que este entorno —RCSI
apagado, transacciones largas, incidentes de bloqueo— tiene todas las condiciones para sufrir
y que ninguna auditoría había tocado aún.

**Reglas nuevas (2, ambas `[gen]`):**

| Regla | Por qué se añadió |
|---|---|
| **R-26** `SET XACT_ABORT ON` en procedimientos transaccionales | El mecanismo del *head blocker* dormido: un timeout de cliente aborta sin revertir, la sesión queda `sleeping` con la transacción abierta y los locks retenidos. `TRY/CATCH` no cubre este caso. Directamente relevante para los incidentes de bloqueo ya investigados |
| **R-27** Orden de acceso consistente entre procedimientos | Deadlocks estructurales por escritura en orden inverso. Incluye la consulta contra `system_health` que recupera deadlocks recientes sin configurar nada |

**Reglas reforzadas:**

- **R-09** (`NOLOCK`/RCSI): al proponer habilitar RCSI hay que presupuestar el *version store*
  en tempdb y los +14 bytes por fila. La regla recomendaba evaluar RCSI sin decir su costo.

**Corrección de método (vive en `analisis-bd`, se anota aquí por trazabilidad):** la garantía
de verificación con `EXCEPT` tenía un agujero — `EXCEPT` aplica `DISTINCT` implícito y no
detecta diferencias de **multiplicidad** (`{A,A,B}` vs `{A,B,B}` pasa limpio con conteos
iguales). El protocolo ahora exige comparar además los grupos (`GROUP BY` de todas las
columnas + `COUNT(*)`) cuando los duplicados son posibles.

---

## En observación — candidatos sin caso propio todavía

Señales a buscar en las próximas auditorías. Con un caso medido, se promueven a regla; sin
caso tras varias auditorías, se descartan y se anota por qué.

| Candidato | Qué buscar |
|---|---|
| Estadísticas obsoletas / *ascending key* | `sys.dm_db_stats_properties`: fecha vieja + millones de modificaciones en tablas grandes; predicados sobre el rango "nuevo" con estimación de 1 fila |
| FKs no confiables | `sys.foreign_keys WHERE is_not_trusted = 1`: el optimizador no puede eliminar joins ni asumir integridad |
| `MERGE` con condición de carrera | `MERGE` sin `HOLDLOCK`: dos ejecuciones concurrentes insertan la misma clave |
| Colisión de *collation* en `#temp` | Joins entre `#temp` (collation de instancia) y bases de usuario con collation distinta: error o conversión implícita |
| Crecimiento del *version store* | Si se habilita RCSI: `sys.dm_tran_version_store_space_usage` tras las transacciones más largas |

---

## v2 — 2026-07-24 · Bloqueo en un procedimiento de menú

**Origen:** auditoría de un procedimiento de alta frecuencia (302 líneas, 53 joins) que apareció
como participante en una cadena de bloqueo productiva. Instancia SQL Server 2016, compat 130,
Always On, RCSI apagado.

**Reglas nuevas (7):**

| Regla | Por qué se añadió |
|---|---|
| **R-05** `SELECT ... INTO #temp` bloquea la instancia | Causa raíz del incidente. No estaba en el catálogo y es el mecanismo por el que un SP de **solo lectura** se vuelve cabeza de cadena |
| **R-06** Predicados catch-all | El detonante: plan compilado para un caso de 0 filas, reutilizado en uno grande |
| **R-13** `ORDER BY` en `SELECT ... INTO` se pierde | Defecto de correctitud introducido por una refactorización previa. Sobrevivió sin detectarse porque *a veces* el orden salía bien |
| **R-19** Table variables estiman 1 fila | Agravado por consultarlas desde un predicado no sargable |
| **R-20** No unir a un grano más fino que la salida | El `GROUP BY` de 19 columnas era el síntoma, no la causa |
| **R-21** Subconsulta correlacionada que es un `EXISTS` | Encontrada literalmente: un `SELECT TOP 1 CASE…` cuyo `WHERE` hacía que el `CASE` solo pudiera devolver un valor |
| **R-22** Conversión implícita de tipo | `[gen]` — no observada aquí, añadida por frecuencia en entornos .NET |

**Reglas reforzadas:**

- **R-17** (`UNION` → `UNION ALL`): se añadió un caso real donde una rama **dependía** de la
  deduplicación del `UNION`. Refuerza la advertencia que la regla ya traía: el cambio no es
  mecánico. Es el mejor ejemplo del principio "un patrón malo puede sostener la correctitud".
- **R-09** (`NOLOCK`): se añadió el sub-caso **`NOLOCK` parcial** — objetos con decenas de
  hints donde una o dos sentencias se quedaron sin él y bastan para entrar en la cadena.
- **R-23** (índices): se añadieron los sub-casos **redundante por prefijo** y **duplicado
  exacto**, con la conexión que faltaba: los escritores lentos son quienes bloquean a los
  lectores, así que borrar índices de más es una medida **anti-bloqueo**, no solo de espacio.

**Lección de método, no de T-SQL:** la verificación de equivalencia con `EXCEPT` en ambas
direcciones detectó a tiempo que dos de las "optimizaciones obvias" habrían cambiado
resultados. Esa práctica quedó como garantía obligatoria en el skill `analisis-bd`.

---

## v1 — 2026-07-21 · Semilla · Estándar derivado de auditoría de código

**Origen:** análisis de ~5 800 líneas de código productivo — 17 objetos entre procedimientos,
funciones, vistas y triggers, escritos por 6+ autores a lo largo de varios años. 35 hallazgos
reales, destilados en 18 reglas.

**Aporta:** los 4 niveles (órdenes de magnitud / corrección / diseño / esquema-instancia), las
reglas **R-01 a R-04**, **R-07 a R-12**, **R-14 a R-18**, **R-23 a R-25**, las consultas de
detección, y el checklist de code review.

**La observación que justifica que exista un estándar y no más parches:** los mismos
anti-patrones aparecían en objetos escritos por personas distintas a lo largo de años. No son
descuidos aislados — son **el estilo por defecto del equipo**. Corregir los objetos sin fijar el
estándar garantiza que vuelvan a aparecer.

---

# Cómo añadir una entrada

Al cerrar una investigación (ver skill `analisis-bd`), antes de dar el trabajo por terminado:

1. **Revisa los hallazgos confirmados** contra [`reglas.md`](reglas.md).
2. **Clasifica cada uno:**
   - Ya existe y el caso nuevo no aporta → no toques nada.
   - Ya existe pero el caso nuevo revela un sub-caso, una trampa o una consecuencia que no
     estaba → **refuerza** la regla y anótalo abajo.
   - No existe → **regla nueva**, con número siguiente y en el nivel que le corresponda.
3. **Escribe la entrada** con la fecha, el origen anonimizado y la tabla de reglas nuevas y
   reforzadas.
4. **Actualiza el índice** de `SKILL.md` si añadiste reglas.
5. **Valida antes de cerrar** — `npm run validate:skills` desde la raíz del repo (ejecuta
   `references/validar.mjs`, solo Node nativo). Exit 0 o no se cierra la versión. El escaneo
   de anonimización no lo cubre el script: hazlo a mano contra la política de `SKILL.md`.

## Qué NO se promueve al catálogo

- Hallazgos **no verificados**. Si no lo mediste, no es una regla: es una sospecha.
- Lo específico de un objeto que no generaliza. Una regla debe poder aplicarse a código que
  nadie de los presentes ha visto.
- Preferencias de estilo sin costo medible detrás.

## Numeración

Los números **no se reciclan**. Si una regla se retira, se marca como retirada y se explica por
qué —eso también es conocimiento— pero su número no se reutiliza.
