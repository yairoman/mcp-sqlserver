# Registro de la base de conocimiento

Bitácora de cómo ha crecido este catálogo. Cada entrada dice **qué se añadió**, **de dónde
salió** y **qué lo motivó**, sin identificar el origen.

Sirve para tres cosas: saber si una regla lleva tiempo validada o es reciente, evitar volver a
añadir lo mismo con otro nombre, y ver qué patrones se repiten entre auditorías — que es la
señal de que son estilo del equipo y no descuidos.

---

## v7 — 2026-07-30 · Un orquestador de carga reportado como lento

**Origen:** análisis de rendimiento de un procedimiento orquestador —247 líneas, 10 `EXEC`
anidados dentro de una transacción explícita, 2.527 llamadas en 30 días— a raíz de una ejecución
reportada como lenta. Árbol de 4 objetos, 1.949 líneas, 155 `JOIN` y 190 hints `NOLOCK`.
Instancia SQL Server 2016, compat 130, RCSI apagado, Developer Edition, Query Store en modo
`AUTO`. Tabla implicada: 5.975.400 filas con **16 índices**, cruzada contra otras de 17,9 M y
8,8 M.

Dos cosas hacen esta entrada distinta de las anteriores. **La primera: los parámetros del
reporte no ejecutaban nada** — el identificador no existía (el máximo de la tabla era menor) y
el procedimiento salía por la rama de error en milisegundos. El 54 % de las llamadas de 30 días
moría en esa misma validación. Todo el análisis útil vino de la evidencia agregada, no del caso
reportado; conviene comprobar que el caso que te dan es representativo **antes** de medirlo.
**La segunda:** el hallazgo principal no era un anti-patrón de los que este catálogo ya listaba,
sino una ausencia — un predicado que no llegaba a formar prefijo de ninguna clave.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-32** Un predicado que no cubre el prefijo de ninguna clave | Un `JOIN` de tres tablas, sin funciones sobre columnas y de aspecto trivial, hacía un `Index Scan` de **5.975.400 filas para devolver 1**: **25.919 lecturas lógicas**. Filtraba por la segunda columna de un PK `(colA, colB)` sin aportar la primera, y ninguno de los 16 índices encabezaba por ella. La tabla escaneada **no aportaba ninguna columna a la salida** — era un `EXISTS` disfrazado. Añadir el predicado que faltaba: **389 ms → 32 ms**, resultado idéntico. Trae además el método de equivalencia para este caso: las dos versiones **sí difieren** en la consulta aislada, y compararlas ahí da un falso negativo que frena una reescritura correcta — hay que comparar en el consumidor. La divergencia era masiva: **1.567.526** valores de `colB` bajo más de un `colA` |

**Reglas reforzadas:**

- **R-25** (configuración de la instancia): el sub-caso **contraintuitivo**. Hasta ahora la regla
  decía que los defaults de fábrica son malos. Aquí la configuración ya estaba **corregida**
  —`cost threshold` en 50, `MAXDOP` 4 sobre 8 schedulers— y fue justamente esa corrección la que
  destapó el problema: una consulta pasó de plan paralelo a DOP 8 (**171,7 ms**, 1.072
  ejecuciones) a plan serial (**381,1 ms**) de un día para otro sin tocar el código, porque su
  coste de 20,6 quedó bajo el umbral nuevo. Query Store conservaba ambos planes con sus fechas.
  El ajuste no causó la regresión: **retiró la anestesia**. Corolario práctico: al subir
  `cost threshold` en una instancia con historia, cuenta con consultas «nuevas» en los informes
  de lentitud, y arregla el código en vez de revertir el parámetro.
- **R-26** (`XACT_ABORT`): la **asimetría padre/hijo**, que es peor que la ausencia uniforme. Un
  orquestador sin `XACT_ABORT` cuyos hijos **sí** lo activan: cuando un hijo revienta, la
  transacción llega al `CATCH` del padre ya deshecha, el `ROLLBACK` incondicional encuentra
  `@@TRANCOUNT = 0` y lanza el **error 3903**, que **escapa del propio `CATCH`**. El cliente
  recibe 3903 en lugar del error real y la línea que registraría el fallo nunca se ejecuta. No
  es un `CATCH` vacío (R-11): es peor, porque **parece** que registra. Incluye la consulta que
  cruza padres sin `XACT_ABORT` con hijos que lo tienen.
- **R-20** (grano más fino que la salida): la señal **objetiva** de que una consulta se le ha ido
  de las manos al optimizador, que evita contar `JOIN`s a ojo.
  `StatementOptmEarlyAbortReason = TimeOut` significa que agotó el presupuesto de búsqueda y
  entregó el plan que tenía a mano. Medido sobre un `INSERT` de ~25 tablas con `CROSS APPLY`,
  `UNION ALL` y `GROUP BY` de 30 columnas: **648 ms y 13.032 KB de compilación**, y en ejecución
  **43,4 ms de CPU sobre 54,5 ms con solo 401 lecturas** —cómputo, no E/S— con *grant* de ~54 MB
  para devolver del orden de una fila. Con sus dos trampas: `CAST(query_plan AS XML)` falla con
  error **6335** si el plan pasa de **128 niveles de anidamiento** (que ya es la respuesta), y el
  tiempo de compilación se amortiza si el plan se reutiliza — comprueba cuántos planes tiene la
  consulta antes de culpar a la compilación.

**Ampliación del mismo trabajo — una segunda ejecución del mismo objeto**

Se analizó un segundo juego de parámetros sobre el mismo procedimiento. El primero salía por la
rama de error y **nunca escribía nada**; el segundo recorre el camino completo. Eso, por sí
solo, ya es una lección de método: **un caso que no ejecuta el código que quieres medir no es
una muestra del problema**, y medirlo habría dado un objeto rápido y sin defectos.

Del segundo caso salió el hallazgo más grave de toda la investigación, invisible desde el
primero porque exige mirar **datos escritos**:

- **R-12** (determinismo) — el sub-caso **opuesto** al que ya estaba, y que cierra la regla. La
  versión anterior enseñaba a medir la ambigüedad antes de «arreglar» un `TOP 1`, con un caso
  donde el no-determinismo era **teórico** (46.455 entidades → un valor cada una). Aquí la
  ambigüedad es **real y masiva**, y el patrón es peor de lo que la regla describía: el mismo
  procedimiento resolvía **dos veces** el mismo identificador de catálogo desde la misma columna
  origen, con **dos reglas de desempate distintas** —`TOP 1` sin `ORDER BY` en una rama,
  `ROW_NUMBER() … ORDER BY … ASC` en la otra—, escribiendo cada resultado en una tabla distinta
  dentro de la misma transacción. Medido: **244 de 1.306 orígenes con más de un destino** (hasta
  **163**), **61.444 de 3.398.789 registros (1,81 %) ya discrepan** entre las dos tablas, y para
  un único origen se habían escrito **cuatro identificadores distintos** (724.847 · 18.829 · 59
  · 15). Aporta además la técnica de detección que faltaba: **un `TOP 1` no determinista no se
  delata en la tabla que escribe** —cada fila parece correcta por separado— sino al **cruzar dos
  escrituras del mismo dato**. Y el recordatorio de que unificar la regla es trivial pero
  *elegirla* es negocio: un script que decida por su cuenta deja miles de filas «corregidas»
  hacia un valor que nadie validó.

**Revisado y NO promovido:**

- Una UDF escalar multi-sentencia con `WHILE` y `FORMAT`, invocada cross-database y sin
  posibilidad de *inlining* en compat 130, serializando el plan de quien la llama: **R-14 ya lo
  cubre** y el caso no aporta un sub-caso nuevo. Se midió además que su serialización **no
  costaba nada hoy**, porque el coste de la sentencia (12,98) queda bajo el umbral de
  paralelismo — un recordatorio de que el anti-patrón estaba presente pero no era el culpable.
- Que la UDF devuelva mal los negativos (`'-1.5'` → `'-2.5'`, medido) es un defecto **del
  objeto**, no un patrón que generalice. Queda en el informe como hallazgo funcional.
- Tres índices sin una sola lectura en 57 días sobre la tabla de 5,97 M: **R-23 ya lo cubre**, y
  además la medición viene de una instancia Developer cuya carga no es la de producción — no
  cumple el listón de «si no lo mediste bien, es una sospecha».
- Dos banderas `BIT` declaradas sin inicializar que viajan como `NULL` y funcionan por accidente
  —`IF @x = 1` con `NULL` es falso, que casualmente es lo que se quería—: es higiene de un objeto
  concreto y no generaliza a un patrón con costo medible. Queda en el informe como hallazgo
  funcional.

## v6 — 2026-07-27 · Revisión de un procedimiento tras un cambio de criterio

**Origen:** revisión de buenas prácticas de un procedimiento de validación de existencia —74
líneas, 7 consultas, devuelve un único escalar 1/0— a raíz de un ticket reciente que añadió la
exclusión de un estado «inactivo». Instancia SQL Server 2016, compat 130, RCSI apagado,
Developer Edition, Query Store activo en modo `AUTO`. Tablas implicadas: una de detalle de
75,7 M filas y 11,91 GB, su cabecera de 398 K y un padrón de 143 K.

Es la primera entrada donde **el objeto no tenía nada que optimizar**: 296 lecturas lógicas y
1,22 ms de promedio medidos en Query Store. Todo lo que se buscó por el lado del rendimiento se
midió y **se descartó**; lo que quedó fue un defecto de lógica que devuelve mal el 2,4 % de los
casos. Y es también la primera vez que dos reescrituras «evidentemente mejores» —cambiar la
tabla conductora, y hacer sargable un predicado— salieron peor o neutras al medirlas.

**Reglas nuevas (2):**

| Regla | Por qué se añadió |
|---|---|
| **R-30** Un filtro nuevo se aplica a todas las condiciones hermanas | El ticket añadió «excluir inactivos» a la consulta que resolvía un identificador, y dejó sin tocar otra condición del mismo objeto que responde a la misma pregunta de negocio. Medido sobre las **143.246** entidades del padrón: **3.546** contestaban que no por esa condición y **3.410** habrían cambiado de respuesta con el filtro aplicado. El comentario del ticket certificaba una intención que el código no cumplía |
| **R-31** Una condición que ya es cierta dentro de su propia rama | `IF NOT EXISTS(A) OR EXISTS(B) … ELSE IF C OR D OR A`: entrar al `ELSE` garantiza `A`, así que el bloque siempre devolvía 1, `C` y `D` nunca decidían nada —`D` recorría la tabla de 75,7 M filas para ello— y la rama contraria era inalcanzable. **Tres de las siete consultas** del objeto no influían en el resultado. El daño no es el trabajo desperdiciado: es que un bloque muerto atrae mantenimiento como si estuviera vivo |

**Reglas reforzadas:**

- **R-01** (función sobre columna): el caso **inverso** al que ya estaba. Si la columna es
  **nullable**, el `ISNULL()` puede ser justo lo que sostiene la corrección —`ISNULL(col,0) NOT
  IN (6)` incluye los `NULL`, `col NOT IN (6)` los descarta—, así que quitarlo sin la rama
  `IS NULL` cambia el resultado. Y la segunda mitad de la trampa: hacerlo sargable **puede no
  servir de nada**. Medido, con el `seek` yendo por otra columna del índice compuesto:
  **309.297 lecturas frente a 309.329**, 0,01 % de diferencia sobre 20.000 ejecuciones.
- **R-12** (determinismo): el `ORDER BY` que la regla pedía **costó un timeout**. Sobre un
  `TOP 1` que atravesaba un fan-out de ~590 filas por llamada, añadirlo pasó de sub-segundo a
  **más de 30 s** en un lote de 20.000, porque impide parar en la primera fila. Añade el paso
  previo que faltaba: medir cuántas filas puede devolver de verdad —aquí, **46.455 entidades
  con exactamente un valor cada una**— y, si el no-determinismo es teórico, resolverlo con una
  restricción de datos o documentarlo con su cifra, no con un `ORDER BY` treinta veces más caro.
- **R-20** (grano más fino que la salida): **contraejemplo medido**. Conducir desde la tabla
  pequeña (52 filas) y convertir el detalle en `EXISTS` —el arreglo canónico de la regla— salió
  **peor**: **409.086 lecturas y 482,9 ms de CPU frente a 309.329 y 394,2**, sobre lotes
  idénticos de 20.000. Motivo: obliga a 52 sondas semi-join por llamada donde antes había un
  `seek` y un recorrido acotado ya cubierto por índice. Acota la regla a su caso real —el
  fan-out que se **colapsa** después con un `GROUP BY`— y no al que ya se corta solo con `TOP`
  o `EXISTS`.
- **R-28** (la instrumentación se audita): dos corolarios nuevos, ambos sobre Query Store.
  **(1)** El modo `AUTO` descarta las consultas triviales: la **ausencia** de un statement no
  prueba que no se ejecute, y en este objeto habría llevado a concluir justo lo contrario de lo
  que la regla advierte. **(2)** El instrumento se mide a sí mismo: una consulta de diagnóstico
  filtrada por un literal coincidió con su propio filtro y atribuyó sus **9.309 lecturas** de
  barrido sobre las vistas internas a la sentencia que pretendía medir —dos órdenes de magnitud
  de error, detectado solo al imprimir el texto capturado—.
- **Higiene**: fila nueva — el identificador de catálogo resuelto por su literal y degradado con
  `ISNULL(@id, -1)`. El `-1` convierte «no encontrado» en «no excluyas nada»: una corrección de
  traducción desactiva el filtro sin error y sin rastro. Agravante observado: en el mismo objeto
  dos estados iban escritos a mano y solo el tercero se buscaba por nombre.

**Lo que no se promovió:** el índice cuya clave es prefijo estricto del PK (2,37 GB sobre 75,7 M
filas) y el par de índices exactamente duplicados — R-23 ya cubre ambas formas y el caso solo
aporta magnitudes. La tabla de detalle como HEAP de 11,91 GB con 141.925 RID lookups — R-24, sin
mecanismo nuevo. Los dos `NOLOCK` sobre catálogos de 21 y 41 filas — R-09. La columna sin
calificar dentro de un join de dos tablas — ya está en higiene. Tampoco se promovió nada sobre
el reloj de pared como métrica: que fuera ruido (490 ms y 694 ms en dos pasadas consecutivas del
mismo lote) es una observación metodológica de esta instancia, no una regla de T-SQL.

---

## v5 — 2026-07-27 · Bloqueos en un procedimiento de captura con envío

**Origen:** incidente real de bloqueo en producción, reportado sobre un procedimiento de 2.183
líneas que concentra doce operaciones distintas seleccionadas por un parámetro numérico, con
paso de parámetros en cadena `clave=valor`. Instancia SQL Server 2016, compat 130, RCSI apagado,
Always On con 58 réplicas, MAXDOP 4. Medido en una copia Developer Edition **sin tráfico del
módulo**: no hubo captura del bloqueo en vivo, así que el diagnóstico se sostuvo en estructura,
volúmenes, política de escalada y la huella dejada en los datos.

Es la primera entrada del catálogo donde **el bloqueo y una pérdida de datos resultan ser el
mismo defecto**, y donde el hallazgo decisivo salió de los datos, no del código: el reparto de
una columna delató la sentencia culpable antes de que la lectura del código lo confirmara.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-29** Un identificador sin validar en el `WHERE` de una escritura masiva | Un parámetro que puede llegar con el centinela `0`/`''` usado tal cual en un `UPDATE`. El centinela no identifica una entidad: identifica el cajón de las que aún no la tienen. Medido: **618.580 filas** en el centinela frente a **12 de media** por identificador real, sobre una tabla de 4,76 M filas y 1,88 GB con `lock_escalation = TABLE` — escalada a lock exclusivo de tabla **y** 618.528 filas inactivadas que nadie pidió inactivar. Trae la técnica de diagnóstico que lo destapó: comparar la bandera de baja contra su fecha, porque un `UPDATE` mal filtrado pone la bandera y deja la fecha vacía |

**Reglas reforzadas:**

- **R-26** (`XACT_ABORT`): pasa de `[gen]` a **`[obs]`** — primer caso observado. Tres
  `BEGIN TRAN` y cero `XACT_ABORT` en el mismo objeto, que sin embargo declaraba
  `SET ARITHABORT ON` dos veces seguidas. El matiz que aporta: no se omite por criterio, se
  omite porque no estaba en la plantilla de la que se copió el objeto.
- **R-10** (transacciones anidadas): sub-caso nuevo y de mucho impacto práctico — el `COMMIT`
  con `@@TRANCOUNT > 1` **sólo decrementa el contador**; no confirma ni libera un solo lock.
  Leído de arriba abajo el código parece cerrar pronto y no cierra nada. Con el corolario del
  `ROLLBACK` interno que revierte la transacción externa y hace fallar su `COMMIT` con error
  3902. Añade la regla de medición: la ventana de bloqueo se cuenta hasta el commit que deja
  `@@TRANCOUNT` en 0, no hasta el que se ve.
- **R-05** (`SELECT INTO`): sub-caso del catálogo materializado sin filtro — seis tablas de un
  catálogo geográfico volcadas enteras a tempdb, **159.534 filas**, para cruzarlas contra 12.
  Incluye por qué cuesta detectarlo en revisión: el `WHERE 1=1` de la subconsulta interior
  aparenta un filtro que no existe.

**Lo que no se promovió:** los hallazgos ya cubiertos sin matiz nuevo — `NOLOCK` decidiendo un
`INSERT` (R-09), predicado *catch-all* con función sobre la columna (R-06, R-01), parámetros en
cadena `clave=valor` (R-18), asignación de variable sin `TOP`/`ORDER BY` (R-12), `CATCH` sin
`THROW` (R-11). Tampoco las 36 pasadas repitiendo la misma cadena de joins: es un caso claro de
trabajo repetido, pero no se midió su costo aislado, así que es una observación, no una regla.

---

## v4 — 2026-07-24 · Revisión del dispositivo de captura de deadlocks

**Origen:** revisión de un job de análisis de deadlocks —herramienta de terceros, instalada en
`master`— sobre una instancia SQL Server 2016 SP3, compat 130, Always On, RCSI apagado, 49
bases, 51 días de uptime. No hubo incidente detonante: se auditó el instrumento de diagnóstico,
no el código de negocio. Es la primera entrada de este catálogo que sale de auditar una
herramienta de observación en vez de un procedimiento.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-28** La instrumentación de diagnóstico también se audita | Una fuente compartida tiene la retención que le deja su emisor más ruidoso. Medido: 12,7 M de eventos en 51 días, 95,3 % ajenos a lo que se buscaba, ventana real de 15 min en memoria y 14 días en disco contra 51 de uptime. El resultado es que **el vacío se lee como ausencia**: cero filas se interpreta como «no pasó nada» en vez de «la evidencia rotó». Trae los dos corolarios: lo que no se persiste no existe, y un job informa hacia atrás mientras una alerta avisa en el momento |

**Reglas reforzadas:**

- **R-25** (configuración por defecto): sub-caso medido del default que apaga la única captura
  nativa de bloqueo — `blocked process threshold (s) = 0`. La asimetría que lo hace importar:
  4 deadlocks en 51 días frente a 7 h 38 min de espera por bloqueo, con un caso individual de
  71,7 minutos, y ni un registro de esto último. Incluye el criterio para elegir el umbral con
  la duración media medida (27 ms de media en `LCK_M_S` ⇒ 15 s, no 5 s).
- **R-27** (orden de acceso / deadlocks): la consulta de detección que traía decía «ya están
  capturados, sin configurar nada». Es cierto y engañoso: ahora lleva la trampa medida y
  redirige a R-28 antes de concluir nada sobre un result set vacío.

**Lo que no se promovió:** la versión antigua de la herramienta de terceros (específico de un
objeto, no generaliza) y el origen concreto del ruido que satura la fuente (no se midió; queda
como sospecha, no como regla).

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
