# Registro de la base de conocimiento

Bitácora de cómo ha crecido este catálogo. Cada entrada dice **qué se añadió**, **de dónde
salió** y **qué lo motivó**, sin identificar el origen.

Sirve para tres cosas: saber si una regla lleva tiempo validada o es reciente, evitar volver a
añadir lo mismo con otro nombre, y ver qué patrones se repiten entre auditorías — que es la
señal de que son estilo del equipo y no descuidos.

---

## v19 — 2026-09-02 · Un seek por el prefijo de la clave que devuelve todas las filas del tipo

**Origen:** análisis de un procedimiento por lotes que revisa el estado de una entidad, llamado en
bucle desde un job, en un entorno no productivo. El coste se repartía en tres mecanismos: una
sentencia cuyo `JOIN` iba por una columna incluida y no de clave, funciones escalares anidadas
que el motor no podía inlinear, y la misma entidad revisada varias veces por lote porque el
productor emite un movimiento por cada documento.

**Ninguna regla nueva y tres reforzadas.** El paquete entrega un índice, porque la sentencia no
cambia, y deja la reescritura de las funciones para una fase con verificación de equivalencia.

**Reglas reforzadas:**

- **R-32** (predicado sin prefijo de clave): la variante silenciosa en la que el plan **sí** hace
  *Index Seek* —por la columna de tipo— pero la columna del `JOIN` es `INCLUDE` y no clave, así
  que el seek devuelve todo el tipo y el igual se aplica como filtro bitmap. Detección:
  `is_included_column` de la columna del join.
- **R-14** (funciones escalares): el inlining de 2019+ estaba activo en la base y no alcanzaba a
  ninguna (`is_inlineable = 0`: variables de tabla, `TOP 1 … ORDER BY`, `IF`), y además anidaban
  tres niveles. Consultar `is_inlineable` antes de dar la regla por resuelta por versión.
- **R-02** (fila a fila): la repetición entre lotes. Consumidor que agrupa por entidad dentro de
  la corrida, productor que inserta un movimiento por documento. Detección por `COUNT(*)` contra
  `COUNT(DISTINCT)` por día; arreglo de una sentencia, decisión del dueño funcional.

---

## v18 — 2026-09-02 · La métrica de un paquete apuntaba a un `query_id` que dejó de existir con el restore

**Origen:** revisión de seguimiento de un paquete de remediación ya entregado, sobre una copia
restaurada desde producción. El diagnóstico se sostuvo; lo que falló fue el script de control,
que filtraba por un `query_id` que solo existía en la telemetría traída por el backup.

**Ninguna regla nueva y tres reforzadas.** Lo que faltaba era proceso, no criterio: el skill
`analisis-bd` incorpora la ficha de **entorno medido** obligatoria al crear la carpeta (Regla 1 y 2),
porque el mismo objeto vive en varias instancias y un informe sin entorno no se puede aplicar ni
comparar.

**Reglas reforzadas:**

- **R-35** (migración y Query Store): el `query_id` **no es un ancla fiable** entre origen y
  destino. Misma sentencia, mismo `object_id`, mismo `context_settings_id`, dos ids. Localizar por
  `query_hash` + `object_id`, agrupar por id y quedarse con la fila viva; y relocalizar tras
  cualquier cambio de texto, porque el parche cambia el hash.
- **R-28** (la instrumentación se audita): dos trampas hermanas del «vacío que se lee como
  ausencia». (1) `sys.dm_exec_requests.logical_reads` es el acumulado del lote entero desde
  `start_time`, no de la sentencia en curso: la atribución por sentencia sale de
  `dm_exec_query_stats` o de Query Store. (2) Query Store tiene un techo de almacenamiento y al
  tocarlo pasa a `READ_ONLY` sin aviso; comprobarlo antes de apoyar una verificación en él.
- **R-36** (filas atascadas en estado intermedio): la variante **sin guard**, en la que la fila no
  detiene la cola sino que desaparece. El proceso escribe «en proceso» en la tabla física antes
  de llamar al hijo y cierra por `JOIN` con una temporal del lote en curso; si el lote muere a
  medias, ningún módulo vuelve a mirar la fila. Arreglo: paso de recuperación al inicio, decidido
  por el dueño funcional.

---

## v17 — 2026-09-02 · Telemetría de producción leída desde una copia

**Origen:** auditoría de una instancia completa no productiva refrescada desde producción. El
*restore* trajo dentro de cada base el Query Store del origen —los planes llevan grabados
`engine_version` y `compatibility_level`—, así que el coste por objeto era el real aunque se
midiera en una copia. Se volcó además el catálogo entero para cruzar el barrido estático del
código con la CPU por objeto.

**Dos reglas nuevas y cinco reforzadas.** El proceso de auditoría de instancia —paso 0 de
permisos, procedencia por `backupset`, rescate del Query Store antes de que se purgue, orden de
medición— se añadió al skill `analisis-bd`, que es donde vive el proceso.

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-42** Una poda que desactiva la integridad de toda la base para borrar en unas pocas tablas | Jobs manuales de poda que abrían con `sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL'` y `DISABLE TRIGGER ALL` sobre toda la base, borraban en bucle con lotes por encima del umbral de escalado a lock de tabla y cerraban con `WITH NOCHECK CHECK CONSTRAINT ALL`, dejando las FK sin confianza. R-04 y R-29 cubrían la transacción larga y el `WHERE` sin validar; ninguna cubría que el guion desactive la integridad de toda la base ni que el tamaño del lote decida el ámbito del lock |
| **R-43** El mantenimiento de índices también es carga: un *rebuild* con *fallback* OFFLINE sobre una bitácora viva bloquea la aplicación | Un job de mantenimiento con `'INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE'` sobre una bitácora con `INSERT` continuo desde la aplicación, coincidiendo con la ventana de backups. En Standard Edition no existe ONLINE: allí el *fallback* es el único camino, y la salida es excluir las bitácoras del *rebuild* y mover la ventana |

**Reglas reforzadas:**

- **R-01** (función sobre columna): sub-caso con **trampa de equivalencia**. Reescribir
  `dateadd(YY, -1, col) < @d` como `col < DATEADD(YEAR, 1, @d)` es sargable y equivalente
  **salvo el 29 de febrero**. La prueba de equivalencia debe ejecutarse con `@d` = hoy **y** con
  `@d` = 29 de febrero del último bisiesto, y la diferencia, si existe, es decisión de negocio.
- **R-02** (fila a fila): dos formas que no estaban. (1) Una **función escalar en el `WHERE`** se
  ejecuta por cada fila candidata, no por cada ejecución; si devuelve 0 cuando no existe fila con
  ciertos tipos, es un `NOT EXISTS` con `IN (a, b)`, un *anti-join* una vez por sentencia. (2) Un
  `WHILE` que hace `INSERT INTO #t EXEC otra_base.dbo.proc` por cada elemento. La detección es
  `count_executions` de la sentencia interior en Query Store, no la del procedimiento.
- **R-03** (triggers set-based): variante engañosa del molde: el trigger **sí calcula**
  `@Count = COUNT(*) FROM inserted`, pero solo para decidir la acción, y después hace
  `SELECT @id = col FROM deleted`. Con N filas, la auditoría guarda una y pierde N−1, sin error.
  Ver `@Count` en un trigger no significa que esté protegido: hay que ver si se usa como guarda.
- **R-24** (heaps y bitácoras): el caso más caro no era una bitácora sino una tabla pequeña
  **sin ningún índice**, borrada por dos columnas millones de veces al mes, mientras sus tablas
  hermanas estaban agrupadas por esas mismas columnas. Y la escala de instancia: miles de heaps,
  una PK como índice no agrupado sobre una tabla fragmentada, y un histórico leído entero por un
  procedimiento de horas.
- **R-39** (jobs): tres trampas hermanas. (1) **Cero fallos porque nunca corre**: jobs de
  mantenimiento habilitados **sin schedule**. (2) **Muchos fallos con una sola causa**: jobs
  clonados de producción cuyo procedimiento no existía en la instancia; se creó una copia con
  otro nombre y se reapuntaron casi todos, y los restantes siguieron fallando durante semanas.
  (3) Agrupar los fallos por `job + paso + mensaje` convierte una lista larga en pocas causas.

---

## v16 — 2026-09-01 · Un `OR` de once caracteres que obliga a arrancar por el universo entero

**Origen:** análisis de un procedimiento de asignación disparado por un job, a partir de una
sesión observada como lenta. La primera medición descartó el diagnóstico intuitivo: no estaba
bloqueada, estaba trabajando. El procedimiento observado resultó ser barato; todo el coste estaba
dos niveles por debajo, en una sola sentencia de un módulo anidado que devolvía un puñado de
filas por ejecución.

**Dos reglas nuevas y tres reforzadas.**

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-40** La recomendación de índice del motor es aritmética sobre las estadísticas que haya | La sugerencia con el *score* más alto de toda una base proponía indexar una columna bandera cuyo predicado selecciona casi toda la tabla, sostenida por estadísticas de meses y con muestreo bajo. La segunda pedía un índice sobre una columna que ya es la segunda del clustered. R-23 advertía que la DMV «sugiere columnas, no índices», pero no que su **cifra de impacto** hay que validarla contra la selectividad real antes de creerla |
| **R-41** Una verificación de equivalencia entre dos conjuntos vacíos pasa limpia | La primera pasada de la prueba de equivalencia dio `EXCEPT` cero en ambas direcciones **y cero filas en los dos lados**: habría pasado por buena. El lote se había tomado por clave ascendente, es decir las filas más antiguas, y un predicado de vigencia presente en ambas formas las descartaba todas. Aporta las dos mitades del arreglo: publicar el **conteo de cada lado** junto a las diferencias y tratar `filas = 0` como fallo, y **diseñar el lote** para que ejercite duplicados, valores fuera de rango y no-coincidencias — que es lo único que distingue un `LEFT JOIN + IS NOT NULL` de un `INNER JOIN` |

**Reglas reforzadas:**

- **R-06** (catch-all): sub-caso con **una forma distinta de las tres que traía la regla**. El
  `OR` no compara un parámetro con una columna: decide **si una tabla filtro participa**
  (`@lista = '' OR f.id IS NOT NULL` sobre un `LEFT JOIN`). El daño tampoco es el habitual —no es
  un plan mal *sniffed*, es que el filtro pequeño que ya está en la mano **no puede ser el lado
  conductor**, así que el plan arranca por el universo entero y descarta al final. Medido aislado
  con la misma salida, la reducción fue de varios órdenes de magnitud, y la gran mayoría de las
  llamadas pasaba filtro concreto, es decir pagaba el plan de la minoría. Dos señales de detección
  baratas: un `LEFT JOIN` con `IS NOT NULL` sobre esa misma tabla en el `WHERE`, y una consulta
  que acumula recompilaciones sin mejorar, con todos sus planes cacheados igual de malos, así que
  no hay plan bueno que forzar.

- **R-02** (procedimiento en bucle fila por fila): sub-caso que **cambia la prioridad del
  arreglo**. Con Always On en `SYNCHRONOUS_COMMIT`, cada sentencia suelta del bucle es su propia
  transacción implícita y paga una espera de red por commit. Agrupar las escrituras del bucle
  quita CPU y latencia a la vez, sin tocar lógica de negocio: suele ser el cambio más fácil de
  justificar de todo el rediseño.

- **R-28** (auditar la instrumentación): dos trampas de lectura que dan cifras falsas sin error, y
  ambas se cometieron y corrigieron en esta misma investigación.
  `sys.dm_exec_procedure_stats` **incluye el costo de los módulos anidados**, así que sumar
  envoltorio e hijos duplica; la pista que lo delata es que comparten `execution_count` y
  `last_execution_time`. Y `EstimateRows` de un operador de scan **no es la cardinalidad de la
  tabla** sino la salida estimada tras los predicados. Para volumen real,
  `sys.dm_db_partition_stats`.

- **R-23** (un índice de más también cuesta): sub-caso con **un coste que la regla no
  contemplaba**. Un índice muerto no solo cuesta escrituras: el optimizador usa cualquier
  estadística que cubra una columna para estimar cardinalidad, **la use o no el plan final**. Así
  que el histograma vencido de un índice sin uso puede ser la fuente de la estimación de un
  predicado en consultas que ni lo tocan. Es un argumento más para retirarlo, y uno contra crear
  índices «por si acaso»: cada uno añade una estadística que mantener y una fuente más de
  estimaciones malas.

**Lección de método, no de T-SQL:** tres de los hallazgos que este análisis publicó primero
resultaron equivocados al obtener acceso completo a las bases, y hubo que retirarlos —dos
recomendaciones de índice y un conjunto de cardinalidades leídas del plan. El patrón común es que
las tres eran **cifras derivadas** (un *score* de la DMV, un `EstimateRows`) tratadas como
mediciones. La regla que queda es la que ya estaba en `SKILL.md` y ahora tiene tres casos:
si no lo contaste, dilo como estimación.

---

## v15 — 2026-08-31 · Un servidor sin presión: todo el coste estaba en el código y en un job

**Origen:** revisión general de rendimiento de una instancia, sin incidente asociado. La
respuesta corta fue que la configuración estaba bien y que todo el coste estaba en el código y
en un job. Tres mediciones descartaron el diagnóstico intuitivo: espera de señal despreciable,
ninguna concesión de memoria pendiente y ninguna sesión bloqueada en la ventana medida.

**Una regla nueva y cinco reforzadas.**

**Regla nueva:**

| Regla | Por qué se añadió |
|---|---|
| **R-39** Un job que no cabe en su propio intervalo no falla: deja de ejecutarse | Un job programado con un intervalo corto cuya duración máxima lo superaba varias veces, con cero fallos. El Agent descarta los arranques solapados sin registrar nada: el proceso corre a una fracción de su ritmo y todos los paneles lo dan por verde. Aporta además dos cosas que no estaban en el catálogo: que la **media miente** —un reparto bimodal de duraciones que hay que separar entre *parameter sniffing* y volumen real antes de tocar nada— y la trampa aritmética de `run_duration`, que es `HHMMSS` y no segundos, así que un `AVG` sobre él no significa nada |

**Reglas reforzadas:**

- **R-19** (table variables): sub-caso que **corrige el alcance de la regla**. Estaba escrita
  alrededor de «en compat < 150 no hay *deferred compilation*», lo que se lee como que 150+ lo
  resuelve. No lo resuelve: la compilación diferida estima **una sola vez**, sin estadísticas y
  sin recompilar por cambio de volumen. Medido en compat 160: un `INSERT INTO @tabla` era la
  sentencia más cara de la instancia. La nota operativa: al estimar la ganancia de subir el
  compat level, no cuentes las table variables como resueltas.

- **R-34** (duración ≫ CPU es espera): sub-caso nuevo con **la firma inversa**, que la regla no
  cubría. `CPU media > duración media` solo puede significar varios hilos, y el cociente aproxima
  el DOP efectivo. El paralelismo encabezaba el ranking de esperas y era el efecto, no la causa:
  estimación de cardinalidad equivocada. Subir `cost threshold` los habría sacado del informe sin
  arreglar nada.

- **R-14** (funciones escalares): **tercera reproducción** del sub-caso de la UDF que aparece dos
  veces en el plan cache: el cuerpo con decenas de miles de ejecuciones frente a una de la
  consulta padre. Lo que aporta de nuevo, y contradice una lectura razonable de la regla
  anterior: la base estaba en compat 160 y el inlining **no se aplicó**. Se añade la comprobación
  que lo zanja (`sys.sql_modules.is_inlineable`) y los dos descalificadores presentes en el caso:
  función declarada en otra base y cuerpo `SELECT TOP 1 @variable = …`.

- **R-25** (configuración por defecto): sub-caso nuevo, **la configuración por base**. La regla
  nació mirando `sp_configure`, que son diez valores en un sitio; el barrido por
  `sys.databases` encontró bases sin `CHECKSUM` (alguna en `NONE`), estadísticas automáticas
  apagadas, `AUTO_SHRINK` en una base de bitácora y compat por debajo del motor sin Query Store.
  Dos detalles que lo hacen regla y no anécdota: las bases afectadas **no eran las dormidas**, y
  la herramienta de auditoría de configuración **abortó con error 916** en la primera base sin
  acceso devolviendo cero hallazgos, mientras el barrido por `sys.databases` lo encontró
  completo. Se añade además la advertencia de que `PAGE_VERIFY CHECKSUM` solo protege lo que se
  escriba a partir de ese momento: prometer que el `ALTER` cierra el riesgo es falso.

- **R-28** (la instrumentación se audita): segunda reproducción del sub-caso «el instrumento *es*
  el consumo», por una vía distinta y por eso vale la pena. Aquí el colector no salió en el
  ranking de CPU sino en el de **esperas**: `MSQL_XP` era la segunda de la instancia. Ninguna
  consulta de negocio lo explicaba, y el rastro no estaba en `dm_exec_query_stats` sino en los
  `usecounts` del plan cache. Se añade la heurística —`MSQL_XP` y `PREEMPTIVE_OS_*` sin dueño
  apuntan a un agente externo— y la consulta que lo identifica.

**Revisado y sin cambios:** R-09 (`NOLOCK` sistemático, incluido el interior de la UDF — la regla
ya lo cubre y aquí quedó marcado como decisión funcional, no como defecto a corregir), R-32 (el
`IF EXISTS` sin índice de apoyo es el caso de manual), R-23 (no se pudo aplicar: sin acceso a
las bases no hay forma de ver índices redundantes) y R-06.

**No promovido por no estar verificado:** la causa concreta de la bimodalidad del job de R-39.
Distinguir *parameter sniffing* de volumen real exigía instrumentar el número de filas por
ejecución, y la sesión fue de solo lectura. Queda anotado en el informe como el primer paso del
arreglo, no como hallazgo.

**Límite de la investigación, que condiciona todo lo anterior:** el login solo accedía a una
parte de las bases, y a ninguna de las que encabezaban el consumo. Las DMV de ámbito de servidor
sí respondían, así que se midió el *qué* pero no el *dónde*: sin definición de objetos, sin
índices existentes y sin volúmenes de tabla. Por eso los índices candidatos se entregaron
**comentados**, tras una comprobación previa obligatoria, en vez de como script aplicable.

---

## v14 — 2026-08-17 · El `DELETE` de la alerta no era el que bloqueaba

**Origen:** dos alertas de bloqueo en producción el mismo día, ambas con el mismo par: un paso de
job de SQL Agent —comando `DELETE`— reteniendo a un proceso de aplicación en `UPDATE`. La lectura
intuitiva era que el `DELETE` bloqueaba. Era falsa: los `DELETE` del proceso iban **todos contra
tablas temporales**. Lo que bloqueaba eran los locks acumulados por los `INSERT` anteriores,
retenidos porque una transacción abierta al principio del bucle no confirmaba hasta el final.

**Dos reglas nuevas y tres reforzadas.**

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-37** Una reescritura equivalente puede costar mucho más | El catálogo ya exigía demostrar que una reescritura no cambia el resultado; faltaba la otra mitad. Sacar una condición de la tabla externa fuera de un `NOT EXISTS` es estrictamente equivalente con la columna `NOT NULL`, y medido resultó decenas de veces más lento. Se descartó el cambio. Aporta además el método: ejecutar aisladas, repetir contra la caché, y documentar el descarte con su cifra |
| **R-38** Código ejecutable guardado como datos no existe para el motor | Decenas de scripts viviendo en filas de una tabla. `sys.dm_sql_referencing_entities` devolvía cero filas y `sys.sql_modules` encontraba un solo objeto donde en realidad esos scripts escribían en tablas grandes. El mapa de dependencias previo a un `sp_rename` sale limpio y es falso |

**Reglas reforzadas:**

- **R-09** (`NOLOCK` en lecturas que deciden una escritura): sub-caso nuevo y **el hallazgo de
  fondo de la investigación**. Hasta ahora la regla se apoyaba en duplicados, que un `UNIQUE`
  neutraliza. Aquí la lectura sucia dispara un efecto **fuera de la base**: el lector consulta la
  cola con `(NOLOCK)`, ve filas que el job aún no confirmó, **el servicio envía el correo**, y solo
  después el `UPDATE` choca con el lock. El bloqueo es el síntoma; el defecto es que un `ROLLBACK`
  no revierte un correo enviado. Quedan envíos sin rastro y candidatos a reenvío. La pregunta que
  añade al diagnóstico: *quién leyó la fila antes de que existiera, y qué hizo con ella*.

- **R-04** (transacciones cortas): sub-caso nuevo, **la transacción que envuelve código que no
  puedes leer** — `sp_executesql` sobre scripts guardados como filas. Con él llega la señal que
  conviene interiorizar: la duración deja de correlacionar con el volumen; el mismo día, un lote
  de miles de filas y otro de diez tardaron casi lo mismo. Un `BEGIN TRAN` cuyo coste no
  correlaciona con el trabajo útil no se ajusta, se acota.

- **R-11** (un `CATCH` vacío es un error que nadie verá): sub-caso desde el lado del llamador.
  `IF @@ERROR <> 0` después de un `EXEC` es una comprobación que **parece** existir: si el código
  ejecutado trae su propio `TRY/CATCH` y no relanza, `@@ERROR` vale 0. Una parte de los scripts lo
  traía, y el job cerraba informando de que todo se había ejecutado correctamente. Se enlaza con
  R-26 por el segundo fallo del mismo patrón: sin `XACT_ABORT`, el bucle sigue con la transacción
  abierta.

**Revisado y sin cambios:** R-01 (el `CONVERT(VarChar(8), Fecha, 112)` sobre un heap es el caso
de manual, ya cubierto), R-23 (índice sin uso y redundante por prefijo — la regla ya advertía de
comprobar los días de arranque antes de un `DROP`, y aquí eran pocos), R-24 (heaps grandes) y
R-32.

**No promovido por no estar verificado:** la sospecha de que
`UPDATE <tabla> ... FROM <tabla> <alias>` resuelve como producto cartesiano en vez de
correlacionar. Comprobarlo exige escribir y la sesión de análisis fue de solo lectura. Quedó como
hallazgo abierto en el informe, con un test de tres filas para resolverlo en dos minutos. Si se
confirma, entra al catálogo entonces — no antes.

**Nota de método.** La medición cambió la entrega dos veces. La reescritura que iba a entregarse
incluía el cambio que R-37 documenta, y solo se detectó porque la prueba de coste se corrió antes
de cerrar. Y una nota de memoria previa —«sin acceso a `msdb.sysjobsteps`»— resultó falsa en esta
cuenta: el mapa de dependencias sí se pudo completar. Conviene reverificar las restricciones
heredadas en vez de darlas por buenas.

---

## v13 — 2026-08-14 · El bloqueo que ninguna de las dos herramientas de monitoreo podía ver

**Origen:** una pregunta de dos minutos —«¿hubo bloqueos hoy?»— que al tirar del hilo destapó un
hueco estructural de observabilidad. Query Store registraba esperas por lock de decenas de
segundos, varias madrugadas consecutivas a la misma hora y con el mismo `query_id`, pero no puede
nombrar al bloqueador. El job de vigilancia sí lo nombra, y sin embargo solo tenía ruido.
Ninguna de las dos herramientas fallaba; las dos medían fuera de la banda donde ocurrían los
hechos.

**Una regla nueva y dos reforzadas.**

**Regla nueva:**

- **R-36** (`READPAST` en una escritura salta filas en silencio). Es idiomático en la *lectura* de
  una cola y un defecto en la *escritura*: el motor omite las filas bloqueadas, devuelve un
  `@@ROWCOUNT` menor y no avisa. Lo que le da la severidad es la combinación con el guard de
  «trabajo en vuelo» (`IF EXISTS (... estado = 1) RETURN`) que acompaña a estos procesos: **una
  sola fila atascada detiene la cola completa, de forma permanente y silenciosa**, con el job
  reportando éxito. Es un interbloqueo lógico que ninguna herramienta de bloqueo detecta, porque
  no hay ningún lock esperando a nadie.

**Reglas reforzadas:**

- **R-04** (transacciones cortas, nunca envuelvan trabajo externo): sub-caso nuevo, **la llamada
  HTTP síncrona dentro de la transacción**. «Trabajo externo» se venía leyendo como *otro
  procedimiento*; el que de verdad hace daño es la salida a la red. Un procedimiento de cola abría
  `BEGIN TRANSACTION` y dentro hacía un `POST` con `sp_OACreate 'MSXML2.ServerXMLHTTP'`: la
  duración del lock la decidía un servidor web. Y el agravante que convierte lo crónico en
  incidente: el objeto COM se instanciaba **sin `setTimeouts`**, así que el peor caso no estaba
  acotado por nada. Aporta la mitigación barata para cuando el rediseño no cabe todavía, y la
  consulta de detección por `sp_OACreate`/`ServerXMLHTTP` más el interruptor de instancia que lo
  habilita.

- **R-28** (la instrumentación de diagnóstico también se audita): dos corolarios nuevos.

  El primero, **el suelo de detección de un monitor por muestreo**. Si la regla de disparo exige
  ver el síntoma en N muestras consecutivas, el umbral real es `(N-1) × intervalo`, no el
  intervalo. El instrumento no fallaba: empezaba a medir justo donde terminaban los hechos. Con el
  agravante de segundo orden de que un monitor que solo alerta por ruido acaba ignorado, lo que
  deja el hueco sin cubrir *y* sin que nadie lo note.

  El segundo, **que el par bloqueador-bloqueado no se reconstruye a posteriori**. Query Store
  registra quién esperó, nunca quién retuvo; atribuir el bloqueo desde ahí es inferencia temporal,
  no prueba. Lo que lo nombra con evidencia es el blocked process report **más** una sesión de
  Extended Events que lo recoja — y activar uno sin el otro produce la peor situación posible: la
  impresión de que hay monitoreo donde no lo hay.

**Nota de método.** La investigación no produjo ninguna reescritura, y la razón se documentó en el
informe en vez de disimularse: la cuenta del análisis tenía `SELECT` denegado sobre las tablas del
monitor y `VIEW DEFINITION` denegado sobre los procedimientos de `master` —al punto de que el
objeto no aparecía en `sys.objects` y `OBJECT_ID()` devolvía `NULL`, que se lee como «no existe»
cuando significa «no lo puedes ver»—. Sin poder leer el estado no hay verificación posible, así que
se entregaron **parches dirigidos** en lugar de un `_v2`, marcados como no verificados.

---

## v12 — 2026-08-11 · El procedimiento que se abrió por lento y resultó estar mal

**Origen:** continuación directa de v11. El benchmark de migración detectó que el paralelismo era la
mayor parte de la espera de la instancia y lo localizó en una base que aquel trabajo no había
auditado: una fracción mínima de sus ejecuciones consumía más de la mitad de su CPU. Al abrir el
segundo consumidor —un proceso diario de sustitución con muchas tablas temporales, `NOLOCK`
generalizado y varias bases referenciadas— la investigación de rendimiento se convirtió en otra
cosa.

**Ninguna regla nueva; una reforzada a fondo y tres entradas de higiene.** El hallazgo no necesitaba
un número propio: es R-29 —escritura masiva fuera de alcance— llegando por un camino que la regla no
contemplaba.

**Regla reforzada:**

- **R-29** (identificador sin validar en una escritura masiva): sub-caso nuevo, **la precedencia de
  `AND` sobre `OR`**. Hasta ahora la regla cubría el valor centinela; aquí las condiciones de alcance
  estaban todas escritas y correctas, pero **sin paréntesis**, de modo que el motor evaluaba
  `(A AND B AND C AND D) OR (E OR F)` y cualquier fila que cumpliera `E` se saltaba el filtro de
  lote y la marca de baja. El `UPDATE` tocaba muchas más filas de las de su lote y alcanzaba todos
  los lotes en lugar de uno, en un proceso diario que **sobrescribe columnas en vez de insertar
  filas**, así que no deja rastro propio.
  Aporta además el agravante que lo mantuvo invisible durante quién sabe cuánto: en el mismo `WHERE`,
  una condición escrita `col = 'PREFIJO%'` en lugar de `LIKE` coincidía con cero filas donde debía
  coincidir con muchas. **Los dos defectos se tapaban entre sí** —uno ampliaba el alcance, el
  otro apagaba la condición que lo habría hecho notorio— de modo que el resultado nunca fue lo
  bastante raro como para que alguien lo mirara. De ahí la instrucción operativa: cuando encuentres
  uno de los dos, busca el otro en la misma cláusula.

**Higiene — tres entradas nuevas:**

- **`=` con comodín** (`col = 'PREFIJO%'`). El inverso del `LIKE` sin comodines que ya estaba, y el
  peligroso de los dos: no da error, solo devuelve cero filas. Repetido varias veces en el mismo
  objeto.
- **`DELETE`/`UPDATE` con `LEFT JOIN` y `WHERE col NOT IN (...)`**. Doble fallo con `NULL`: el
  `LEFT JOIN` degenera en `INNER JOIN`, y un solo `NULL` en la subconsulta hace que no se borre nada.
- Ambas se detectan comparando conteos, que es lo que las hace baratas de auditar.

**Lo que no se promovió, y por qué.** El resto de hallazgos del caso ya estaban cubiertos y no
aportaban sub-caso: la tabla grande con cero índices no agrupados consultada por columnas que la
clave agrupada no cubre es R-32 literal; los `NOLOCK` en lecturas que deciden escrituras son R-09;
el `TOP 1` sin `ORDER BY` que elige el lote a procesar es R-12; las tablas temporales sin índice
son R-16; los índices sin una sola lectura son R-23 —con su límite bien puesto: unas horas de
medición no descartan un índice mensual—. Que seis reglas distintas aparezcan juntas en un solo
objeto es, en sí, la observación de la v1: no son descuidos aislados, son el estilo por defecto.

**Y una nota metodológica que confirma v11.** Este objeto se localizó porque el delta de esperas de
la instancia contradijo la conclusión sacada de Query Store de una sola base. La regla añadida
entonces —*el alcance de la evidencia tiene que cubrir el alcance de la afirmación*— es lo que hizo
posible este trabajo poco después.

---

## v11 — 2026-08-11 · «Migramos el fin de semana, ¿es mejor?»

**Origen:** benchmark post-migración de dos versiones mayores, pedido pocos días después del
cambio, sobre un servidor nuevo en RTM sin ningún CU. Solo lectura, sin permiso `SHOWPLAN` y sin
acceso a `msdb`. Es la primera entrada de la serie que **compara dos instancias distintas**, y
solo fue posible porque Query Store viaja dentro del backup: el historial medido en el motor viejo
llegó con las bases.

**Una regla nueva y una reforzada.** Lo que distingue esta entrada es que el resultado contradecía
la intuición en las dos direcciones. Se esperaba «la versión nueva es más rápida» y se midió más
lenta; se dedujo entonces «el hardware nuevo es peor» y resultó ser **mejor**: las mismas
consultas leían menos páginas y el disco respondía más rápido.

**Regla nueva:**

- **R-35** (una migración mueve los datos, no la puesta a punto). Aporta cuatro cosas.
  **(1)** El inventario de qué viaja dentro del backup, qué se queda y qué se resetea — y por qué
  lo que viaja es lo peligroso: las estadísticas llegan **con su `modification_counter` intacto**,
  así que parecen correctas por el mero hecho de estar, con histogramas de meses y muestreos
  mínimos. **(2)** La firma diagnóstica, que es lo que hace la regla memorable: **menos lecturas y
  más tiempo** no es hardware peor, es hardware mejor ejecutando planes peores. **(3)** El control
  que lo demuestra —aislar las consultas cuyo I/O no cambió—, que acotó la parte atribuible al
  servidor y sin el cual el informe habría culpado a la máquina nueva. **(4)** El orden de
  remediación: estadísticas primero, CU después, compat level al final, porque subir el compat con
  histogramas viejos es evaluar un optimizador nuevo con datos falsos.

  El coste del compat level dejó de ser un argumento teórico: casi todas las bases seguían en el
  nivel del motor anterior, y una sola base tenía cientos de funciones escalares y decenas de TVF
  multi-sentencia frente a un puñado de TVF inline, con varias funciones escalares entre los
  objetos más degradados. Es exactamente lo que el compat nuevo resuelve sin tocar T-SQL (R-14,
  R-19), y estaba desactivado.

  Se descartó por medición la hipótesis intuitiva: `cost threshold` había caído al valor por
  defecto en la instancia nueva, pero el paralelismo seguía siendo una fracción mínima de las
  ejecuciones. La regresión de configuración es real y se documentó (R-25), pero no era la causa.

**Regla reforzada:**

- **R-28** (la instrumentación se audita): sub-caso nuevo y de aplicación general — **la
  herramienta del que mira**. Hasta ahora la regla cubría el instrumento propio auto-capturándose;
  aquí el ruido lo mete otra persona con SSMS abierto. Las dos consultas con peor regresión de todo
  el conjunto eran del **Object Explorer** —firma `@_msparam_n` sobre alias `clmns`—, y
  encabezaban el ranking precisamente porque nadie navegaba ese servidor antes de migrarlo.
  Publicadas sin filtrar habrían descrito una degradación muy superior a la real. Queda el filtro
  (`NOT LIKE '%msparam%'`), la separación por `object_id` entre código del negocio y ad-hoc, y la
  regla general que las engloba a todas: **antes de dar por buena una consulta de la lista de
  peores, lee su texto**.

**Lo que no se promovió.** Los índices que el motor recomendaba: se acumularon en pocas horas de
uptime y con las estadísticas obsoletas descritas en R-35, de modo que son propuestas para
compensar estimaciones falsas. Medirlos de nuevo tras actualizar estadísticas es parte del plan de
acción, no una regla.

### Adenda — la primera ejecución del script de verificación corrigió el informe

Horas después de entregar el paquete, el cliente ejecutó `99_verificacion.sql` y devolvió su
salida. Esa segunda captura, restada de la primera, **invalidó una conclusión y destapó un defecto
en la propia métrica de seguimiento**. Ambas cosas se promueven a **R-28**, que gana tres
sub-casos más:

- **La media sobre una población que crece deriva sola.** El informe proponía seguir una media
  absoluta de duración. En pocas horas **sin aplicar nada**, esa cifra mejoró: la población
  comparable había crecido al acumular ejecuciones, y las nuevas eran más baratas. Una mejora
  inexistente. **El factor, en cambio, no se movió.** De ahí la regla: la métrica de un
  antes/después es el **cociente de cada consulta contra sí misma**, nunca el agregado absoluto.
  Se añade también la **caducidad**: la ventana «antes» muere con la retención de Query Store, así
  que o se exporta o la medición deja de poder rehacerse.
- **Query Store es por base; las esperas son de la instancia.** El error propio, y el más
  instructivo. De la fracción mínima de ejecuciones paralelas en la base auditada se concluyó
  «paralelismo descartado». Dato correcto, conclusión falsa: el delta de esperas de la
  **instancia** puso `CXCONSUMER`+`CXSYNC_PORT`+`CXPACKET` como la mayor parte de la espera real,
  originado en otra base. Antes de descartar un mecanismo, comprobar que el alcance de la evidencia
  cubre el alcance de la afirmación.
- **Un porcentaje de ejecuciones no mide un porcentaje de coste.** En la base culpable, una
  fracción mínima de las ejecuciones consumía más de la mitad del CPU: una docena de sentencias,
  la primera con cientos de millones de lecturas por ejecución. Con el corolario que evita el
  arreglo equivocado: subir `cost threshold` frena lo trivial, no lo que cuesta órdenes de
  magnitud más que el umbral.

**Y una lección de proceso, sin regla propia:** el script de verificación no es papeleo de cierre.
Aquí fue el instrumento que corrigió el informe que lo acompañaba, horas después de entregarlo. Un
paquete sin `99_verificacion.sql` habría dejado las tres conclusiones erróneas en pie
indefinidamente.

---

## v10 — 2026-08-06 · «Va muy lento desde hace dos días»

**Origen:** reporte de usuarios, sin objeto señalado y sin más pista que la fecha. Misma
instancia que v9. Solo lectura, **sin permiso `SHOWPLAN`**. Query Store estaba activo con
retención suficiente en las bases calientes, y **es la razón por la que esta investigación pudo
concluir algo**: sin él, el hallazgo principal no era demostrable.

**Una regla nueva y dos reforzadas.** Lo que hace distinta esta entrada es el error que estuvo a
punto de cometerse. Las primeras horas apuntaban a los dos consumidores de CPU más obvios —un
colector de monitorización y la limpieza de Change Tracking de una base recién clonada—, ambos
reales, ambos fechados dentro de la ventana reportada, ambos con cifras espectaculares. La
medición de CPU los descartó como causa del síntoma: el servidor estaba ocioso. Un servidor ocioso
no explica usuarios parados; lo explica un servidor **esperando**.

**Regla nueva:**

- **R-34** (una consulta lenta con CPU casi nula está esperando). Sentencias de pantallas de
  búsqueda con decenas de segundos de duración media contra fracciones de milisegundo de CPU y un
  puñado de lecturas, incluido un `INSERT` de una fila en una tabla pequeña que tardaba segundos.
  Aporta cuatro cosas: **(1)** el razonamiento aritmético que cierra el diagnóstico sin necesidad
  de capturar el bloqueo, porque una sentencia que toca seis páginas no puede tardar segundos por
  sí misma; **(2)** la inversión de la lectura habitual — **la CPU baja del servidor es el síntoma,
  no la prueba de salud**; **(3)** por qué las DMV de sesión no valen aquí: un muestreo corto
  registró cero bloqueo y las cadenas salieron limpias con el problema activo, así que sólo Query
  Store, que conserva duración **y** CPU, permite el diagnóstico a posteriori; y **(4)** la tabla
  de descartes —cliente que no consume, consulta remota, espera por memoria—, sin la cual la regla
  sería una corazonada. Con RCSI apagado y `lock_escalation = TABLE` en todas las tablas
  implicadas, el mecanismo queda cerrado.

**Reglas reforzadas:**

- **R-25** (configuración por defecto): **tercera aparición** de los 365 días de Change Tracking,
  y por fin con el mecanismo de propagación visible. Una copia de base heredó las tablas con CT,
  sus tablas laterales y la retención completa, duplicando el coste de limpieza de la instancia al
  mismo ritmo exacto. Que reaparezca por tercera vez ya no es un descuido: es lo que pasa por
  defecto al clonar. Se añade además la **técnica de fechado** que resolvió la investigación —
  cruzar `creation_time` del plan cache contra `create_date` de `sys.databases` fechó el cambio
  con minutos de precisión, sin depender de que nadie recordara qué se hizo.
- **R-28** (la instrumentación se audita): dos sub-casos. El primero invierte la regla —hasta
  ahora trataba la instrumentación como fuente que se degrada; aquí **era el consumo**: una
  métrica de monitorización interrogando el historial de respaldos cada pocos segundos era el
  mayor consumidor de CPU y lecturas de la instancia, recorriendo decenas de veces por ejecución
  la misma tabla. Con el corolario que lo hace invisible: esas filas tienen `dbid` nulo y se caen
  de todo informe ordenado por base. El segundo es metodológico y de aplicación general: **las
  esperas acumuladas no pueden fechar una regresión** —semanas de uptime diluyen dos días—, y lo
  que sí funciona son dos capturas restadas y Query Store agregado **comparando laborables contra
  laborables**, que señaló el día. Contrastar una segunda base descartó la causa de instancia: la
  vecina no se movió.

**Lo que se decidió NO promover.** El entorno tenía material de sobra —casi todos los lotes
provocando compilación, un `UPDATE` entre bases con muchos planes distintos en pocos días, muchos
triggers, sesiones abandonadas—. Nada de eso subió al catálogo: o ya está cubierto por R-06, R-19
y R-23, o no se pudo medir su efecto sobre el síntoma reportado. **Un consumidor grande no es una
causa mientras no se demuestre que alimenta el síntoma**, que es precisamente la lección de esta
entrada.

---

## v9 — 2026-07-31 · «¿Y esto hará que la web vaya más rápida?»

**Origen:** continuación directa de v8. Cerrado el plan de poda, la pregunta del cliente fue si
serviría para acelerar los aplicativos web. La respuesta medida fue que no, y esa negativa abrió la
investigación útil: entonces **qué sí**. Análisis en solo lectura, **sin permiso `SHOWPLAN`**:
ningún hallazgo se apoya en un plan de ejecución.

Ninguna regla nueva: las cuatro reglas que cubren este terreno ya existían y todas salieron
reforzadas con evidencia de otro tipo. Dos cosas hacen esta entrada distinta.

**La primera: la configuración crítica ya estaba corregida.** `cost threshold`, `MAXDOP` y
`optimize for ad hoc` en su sitio. Es la segunda vez que este catálogo se encuentra un entorno así
(ver v7), y la lección se repite: cuando los parámetros están bien, lo que queda es código, y
conviene decirlo pronto para que nadie siga buscando el interruptor mágico.

**La segunda: la conclusión de v8 quedó confirmada por un camino independiente.** v8 dedujo que
podar no aceleraría la aplicación mirando el **uso de índices**. v9 llegó a lo mismo mirando las
**esperas**: `PAGEIOLATCH_SH` muy por debajo del paralelismo. Dos evidencias inconexas apuntando
al mismo sitio valen mucho más que una.

**Reglas reforzadas:**

- **R-33** (reducir volumen no es optimizar): la **comprobación de dos minutos** que decide la
  conversación entera, y que va antes que el uso de índices. `PAGEIOLATCH_*` muy por debajo del
  paralelismo prueba que la instancia no espera por disco, y una base más pequeña solo ahorra
  E/S. Se anota también el recíproco, que es la única forma honesta de rescatar el argumento
  contrario: si `PAGEIOLATCH_*` sí pesa, la reducción de volumen vuelve a la mesa. Y el
  `SOS_SCHEDULER_YIELD` con espera por señal dominante como indicador de presión de CPU.
- **R-14** (funciones escalares): el sub-caso de la **cadena**. La función medida llamaba a otras
  dos funciones escalares, de modo que una invocación disparaba varias consultas, una vez por
  fila. Trae tres cosas nuevas: **(1)** el descarte que ahorra semanas — las tablas recorridas
  eran pequeñas y los índices exactos ya existían, así que el problema era el número de
  invocaciones y ningún índice lo iba a arreglar; **(2)** el alcance aparente engaña — una de las
  funciones de apoyo tenía decenas de referencias, pero con sufijos `_BkUp`, `_notused`, `_Test`,
  `_prueba` y varias con fecha en el nombre; **(3)** la receta de reescritura verificada con
  `EXCEPT` en ambas direcciones, sin diferencias, y su medición: la vía de conjunto procesó un
  orden de magnitud más filas en una fracción del tiempo. Con la advertencia de que no es un
  reemplazo transparente: cambia la forma de invocar, así que hay que editar cada llamador.
- **R-28** (la instrumentación se audita): el **caso inverso** de la regla. Hasta ahora recogía
  «el vacío se lee como ausencia»; aquí **el ruido se lee como señal**. Las esperas mayores de
  `sys.dm_os_wait_stats` sumaban la mayor parte y ninguna era contención: sin filtrar, el
  diagnóstico habría sido «esta instancia espera por Always On». Se añade la exigencia de mirar el
  *signal wait* y el número de tareas, y una trampa aparte: **los totales del plan cache no cubren
  el uptime** —`sys.dm_exec_query_stats` acumula desde `creation_time` de cada plan—, así que en
  una misma foto convivían una fila con días de historia y otra con minutos.
- **R-25** (configuración de la instancia): confirmación de que casi todos los parámetros críticos
  estaban ya en su sitio, y que el que faltaba era otra vez `blocked process threshold` en cero.
  Refuerza el sub-caso que ya recogía la regla: es el parámetro que nadie toca, y sin él no hay
  forma de saber quién bloqueó a quién cuando alguien reporte que la aplicación se quedó colgada.

**Lo que se decidió NO promover:**

- Encender RCSI. Es casi con seguridad la razón de fondo de los `NOLOCK` que aparecen en todo el
  código revisado, pero proponerlo desde un entorno de desarrollo sería exactamente el error que
  R-33 y v8 documentan: se decide sobre producción, con la medición de tempdb delante, y se replica
  hacia abajo. Queda como pendiente en el informe, no como propuesta.

## v8 — 2026-07-30 · Reducir una copia de producción en un entorno de desarrollo

**Origen:** plan de poda de una base grande restaurada desde producción a una instancia de
desarrollo, con el objetivo de conservar solo los últimos años. Muchos heaps, muchas FK no
confiables, RCSI apagado, recovery `FULL` en un entorno de desarrollo. Análisis en solo lectura.

Lo que hace distinta esta entrada: **la premisa de la que partía el trabajo era falsa, y medirla
antes de planificar cambió el orden de todo el plan.** Se pedía una restauración parcial por
fecha; `RESTORE ... WITH PARTIAL` opera sobre *filegroups* y la base tenía uno solo, sin
particionamiento. Descartada esa vía, la pregunta pasó a ser cuánto libera el corte por fecha — y
resultó que una parte sustancial de la base no eran datos de ninguna antigüedad, sino páginas
vacías. La segunda tabla más grande solo contenía unos meses de historia: el corte por fecha no
le quitaba ni una fila.

**Ampliación del 2026-07-31.** El trabajo estaba cerrado cuando llegó la pregunta que lo puso a
prueba: *¿esto hará que los aplicativos web vayan más rápido?* Medirlo cambió la conclusión del
informe y produjo la única regla nueva de esta versión. Las tablas que concentraban el espacio
recuperable registraban cero búsquedas de la aplicación en todo el uptime —solo escrituras—, y la
única que la aplicación castigaba de verdad acumulaba millones de búsquedas y cero escaneos. La
poda seguía justificándose por espacio, backup y tiempo de refresco; por rendimiento, no.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-33** Reducir volumen no es optimizar | El coste de una búsqueda en un índice es **logarítmico** respecto al número de filas y el de un escaneo es **lineal**: toda la ganancia de una reducción de datos se concentra en lo que hace escaneos, y si nada escanea la tabla la ganancia es cero. Las tablas candidatas tenían cero búsquedas entre todas; alguna con muchas escrituras y ninguna lectura. Trae una trampa de método que casi invierte el diagnóstico: **las consultas del propio análisis contaminan `dm_db_index_usage_stats`** — los únicos escaneos registrados llevaban marca de tiempo dentro de la ventana en que se corrieron los `COUNT(*)` de la auditoría, y sin mirar `last_user_scan` se habría concluido que la aplicación sí las lee. Y deja escrito qué **sí** compra una poda —backup, restore, `CHECKDB`, ciclo de refresco, disco—, que es operación y no experiencia de usuario |

Los dos hallazgos de la primera pasada, en cambio, son sub-casos de reglas que ya existían: señal
de que el catálogo va cubriendo el terreno.

**Reglas reforzadas:**

- **R-24** (heaps y bitácoras): el sub-caso **aritmético**, que no necesita ninguna DMV para
  detectarse. `Paginas * 8192.0 / Filas` daba diez veces el máximo de bytes que cabe en una fila,
  en una tabla sin columnas LOB. Solo puede ser espacio muerto: páginas casi vacías, confirmado
  con `avg_page_space_used_in_percent` en modo `SAMPLED` (`LIMITED` devuelve `NULL` ahí). Trae
  tres corolarios que rompen planes de trabajo: **(1)** una poda por antigüedad sobre un heap no
  libera un byte sin `REBUILD` posterior, así que toda estimación de ahorro que lo omita es
  ficción; **(2)** antes de cortar por fecha hay que comprobar que la columna está poblada — una
  bitácora tenía la suya en `NULL` en todas las filas, y otra tabla mezclaba fechas imposibles;
  **(3)** el peso no está donde están las filas: la mayor tabla tenía casi todo su tamaño en
  unidades de asignación LOB, lo que cambia qué técnica de borrado conviene.
- **R-22** (conversión implícita): el sub-caso de **modelo**, no de parámetro. La misma clave
  lógica declarada `varchar(36)` en dos tablas y `uniqueidentifier` en una tercera, **sin una sola
  FK entre las tres**. Medido sobre el mismo corte, el join con conversión costaba varias veces el
  join entre las que comparten tipo. La relación se sostenía por convención: una muestra emparejó
  casi todo, y el resto eran huérfanos que ninguna restricción impedía. Corolario: comprobar el
  tipo en **toda** la cadena de tablas, no solo en las dos que se están mirando, y medir cuántas
  filas emparejan cuando no hay FK que lo garantice.

- **R-25** (configuración de la instancia): **Change Tracking, por segunda vez y en otra
  instancia**, otra vez con 365 días de retención y otra vez como **el mayor consumidor de CPU
  del servidor entero**, con cifras que cubrían días, no el uptime. Habilitado en varias bases con
  retenciones distintas conviviendo. Que reaparezca en un entorno distinto es la señal de que 365
  días no es una decisión sino el valor que queda cuando nadie lo toca. Se añade su huella
  reconocible en el plan cache —consultas con base nula sobre `internal_table_name` y
  `sys.syscommittab`, que no tienen dueño aparente y por eso se pierden en cualquier informe
  ordenado por base— y la consulta de `sys.change_tracking_databases`.
- **R-14** (funciones escalares en un `SELECT`): el sub-caso de **cómo se lee en el plan cache**.
  La UDF aparece **dos veces**, y la segunda es la reveladora: la consulta padre con una
  ejecución, y el cuerpo de la función con decenas de miles. No son costes que se sumen: es el
  mismo trabajo visto desde dentro, y una sola ejecución del padre se abrió en decenas de miles de
  llamadas. Corolario de detección: una fila con un número de ejecuciones desproporcionado y un
  texto que parece un fragmento suelto (`SELECT TOP 1 @variable = …`) casi siempre es el cuerpo
  de una UDF escalar; buscar esa variable en `sys.sql_modules` la identifica.

**Lo que se decidió NO promover:**

- Que `RESTORE ... WITH PARTIAL` trabaje por filegroup es una característica documentada del motor,
  no un anti-patrón de T-SQL. No pertenece a este catálogo.
- Los índices sin lecturas en todo el uptime **no se promovieron ni se propuso borrarlos**: la
  medición venía de una instancia de **desarrollo**, y R-23 ya exige validar el uso antes de un
  `DROP`. El matiz que sí quedó anotado en el informe, y que aquí importa: en una copia cuyo
  propósito es reproducir producción, quitar índices cambia los planes y destruye justamente
  aquello para lo que existe la copia. La decisión se toma sobre producción y se replica hacia
  abajo, nunca al revés.

## v7 — 2026-07-30 · Un orquestador de carga reportado como lento

**Origen:** análisis de rendimiento de un procedimiento orquestador —varios `EXEC` anidados
dentro de una transacción explícita— a raíz de una ejecución reportada como lenta. Árbol de
varios objetos con muchos `JOIN` y `NOLOCK` generalizado. Tabla implicada con muchos índices,
cruzada contra otras grandes.

Dos cosas hacen esta entrada distinta de las anteriores. **La primera: los parámetros del
reporte no ejecutaban nada** — el identificador no existía y el procedimiento salía por la rama
de error en milisegundos. Más de la mitad de las llamadas del periodo moría en esa misma
validación. Todo el análisis útil vino de la evidencia agregada, no del caso reportado; conviene
comprobar que el caso que te dan es representativo **antes** de medirlo. **La segunda:** el
hallazgo principal no era un anti-patrón de los que este catálogo ya listaba, sino una ausencia —
un predicado que no llegaba a formar prefijo de ninguna clave.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-32** Un predicado que no cubre el prefijo de ninguna clave | Un `JOIN` de tres tablas, sin funciones sobre columnas y de aspecto trivial, hacía un `Index Scan` de millones de filas para devolver una. Filtraba por la segunda columna de un PK `(colA, colB)` sin aportar la primera, y ninguno de los índices de la tabla encabezaba por ella. La tabla escaneada **no aportaba ninguna columna a la salida** — era un `EXISTS` disfrazado. Añadir el predicado que faltaba redujo el tiempo un orden de magnitud con resultado idéntico. Trae además el método de equivalencia para este caso: las dos versiones **sí difieren** en la consulta aislada, y compararlas ahí da un falso negativo que frena una reescritura correcta — hay que comparar en el consumidor. La divergencia era masiva |

**Reglas reforzadas:**

- **R-25** (configuración de la instancia): el sub-caso **contraintuitivo**. Hasta ahora la regla
  decía que los defaults de fábrica son malos. Aquí la configuración ya estaba **corregida** y fue
  justamente esa corrección la que destapó el problema: una consulta pasó de plan paralelo a plan
  serial de un día para otro sin tocar el código, porque su coste quedó bajo el umbral nuevo.
  Query Store conservaba ambos planes con sus fechas. El ajuste no causó la regresión: **retiró la
  anestesia**. Corolario práctico: al subir `cost threshold` en una instancia con historia, cuenta
  con consultas «nuevas» en los informes de lentitud, y arregla el código en vez de revertir el
  parámetro.
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
  entregó el plan que tenía a mano. Medido sobre un `INSERT` de decenas de tablas con
  `CROSS APPLY`, `UNION ALL` y un `GROUP BY` de muchas columnas: compilación cara, y en ejecución
  casi todo CPU con pocas lecturas —cómputo, no E/S— y un *grant* de memoria desproporcionado para
  devolver del orden de una fila. Con sus dos trampas: `CAST(query_plan AS XML)` falla con error
  **6335** si el plan pasa de **128 niveles de anidamiento** (que ya es la respuesta), y el tiempo
  de compilación se amortiza si el plan se reutiliza — comprueba cuántos planes tiene la consulta
  antes de culpar a la compilación.

**Ampliación del mismo trabajo — una segunda ejecución del mismo objeto**

Se analizó un segundo juego de parámetros sobre el mismo procedimiento. El primero salía por la
rama de error y **nunca escribía nada**; el segundo recorre el camino completo. Eso, por sí
solo, ya es una lección de método: **un caso que no ejecuta el código que quieres medir no es
una muestra del problema**, y medirlo habría dado un objeto rápido y sin defectos.

Del segundo caso salió el hallazgo más grave de toda la investigación, invisible desde el
primero porque exige mirar **datos escritos**:

- **R-12** (determinismo) — el sub-caso **opuesto** al que ya estaba, y que cierra la regla. La
  versión anterior enseñaba a medir la ambigüedad antes de «arreglar» un `TOP 1`, con un caso
  donde el no-determinismo era **teórico**. Aquí la ambigüedad es **real y masiva**, y el patrón
  es peor de lo que la regla describía: el mismo procedimiento resolvía **dos veces** el mismo
  identificador de catálogo desde la misma columna origen, con **dos reglas de desempate
  distintas** —`TOP 1` sin `ORDER BY` en una rama, `ROW_NUMBER() … ORDER BY … ASC` en la otra—,
  escribiendo cada resultado en una tabla distinta dentro de la misma transacción. Una parte
  apreciable de los orígenes tenía más de un destino, las dos tablas ya discrepaban, y para un
  único origen se habían escrito varios identificadores distintos. Aporta además la técnica de
  detección que faltaba: **un `TOP 1` no determinista no se delata en la tabla que escribe**
  —cada fila parece correcta por separado— sino al **cruzar dos escrituras del mismo dato**. Y el
  recordatorio de que unificar la regla es trivial pero *elegirla* es negocio: un script que
  decida por su cuenta deja miles de filas «corregidas» hacia un valor que nadie validó.

**Revisado y NO promovido:**

- Una UDF escalar multi-sentencia con `WHILE` y `FORMAT`, invocada cross-database y sin
  posibilidad de *inlining* en compat 130, serializando el plan de quien la llama: **R-14 ya lo
  cubre** y el caso no aporta un sub-caso nuevo. Se midió además que su serialización **no
  costaba nada hoy**, porque el coste de la sentencia queda bajo el umbral de paralelismo — un
  recordatorio de que el anti-patrón estaba presente pero no era el culpable.
- Que la UDF devuelva mal los negativos (`'-1.5'` → `'-2.5'`, medido) es un defecto **del
  objeto**, no un patrón que generalice. Queda en el informe como hallazgo funcional.
- Índices sin una sola lectura sobre la tabla grande: **R-23 ya lo cubre**, y además la medición
  viene de una instancia de desarrollo cuya carga no es la de producción — no cumple el listón de
  «si no lo mediste bien, es una sospecha».
- Dos banderas `BIT` declaradas sin inicializar que viajan como `NULL` y funcionan por accidente
  —`IF @x = 1` con `NULL` es falso, que casualmente es lo que se quería—: es higiene de un objeto
  concreto y no generaliza a un patrón con costo medible. Queda en el informe como hallazgo
  funcional.

## v6 — 2026-07-27 · Revisión de un procedimiento tras un cambio de criterio

**Origen:** revisión de buenas prácticas de un procedimiento de validación de existencia —corto,
pocas consultas, devuelve un único escalar 1/0— a raíz de un ticket reciente que añadió la
exclusión de un estado «inactivo». Tablas implicadas: una de detalle grande, su cabecera y un
padrón.

Es la primera entrada donde **el objeto no tenía nada que optimizar**: pocas lecturas y
milisegundos de promedio medidos en Query Store. Todo lo que se buscó por el lado del rendimiento
se midió y **se descartó**; lo que quedó fue un defecto de lógica que devuelve mal una fracción
de los casos. Y es también la primera vez que dos reescrituras «evidentemente mejores» —cambiar
la tabla conductora, y hacer sargable un predicado— salieron peor o neutras al medirlas.

**Reglas nuevas (2):**

| Regla | Por qué se añadió |
|---|---|
| **R-30** Un filtro nuevo se aplica a todas las condiciones hermanas | El ticket añadió «excluir inactivos» a la consulta que resolvía un identificador, y dejó sin tocar otra condición del mismo objeto que responde a la misma pregunta de negocio. Medido sobre el padrón completo: miles de entidades habrían cambiado de respuesta con el filtro aplicado. El comentario del ticket certificaba una intención que el código no cumplía |
| **R-31** Una condición que ya es cierta dentro de su propia rama | `IF NOT EXISTS(A) OR EXISTS(B) … ELSE IF C OR D OR A`: entrar al `ELSE` garantiza `A`, así que el bloque siempre devolvía 1, `C` y `D` nunca decidían nada —`D` recorría la tabla de detalle para ello— y la rama contraria era inalcanzable. Casi la mitad de las consultas del objeto no influían en el resultado. El daño no es el trabajo desperdiciado: es que un bloque muerto atrae mantenimiento como si estuviera vivo |

**Reglas reforzadas:**

- **R-01** (función sobre columna): el caso **inverso** al que ya estaba. Si la columna es
  **nullable**, el `ISNULL()` puede ser justo lo que sostiene la corrección —`ISNULL(col,0) NOT
  IN (6)` incluye los `NULL`, `col NOT IN (6)` los descarta—, así que quitarlo sin la rama
  `IS NULL` cambia el resultado. Y la segunda mitad de la trampa: hacerlo sargable **puede no
  servir de nada**. Medido, con el `seek` yendo por otra columna del índice compuesto, la
  diferencia de lecturas fue despreciable sobre un lote grande.
- **R-12** (determinismo): el `ORDER BY` que la regla pedía **costó un timeout**. Sobre un
  `TOP 1` que atravesaba un fan-out de cientos de filas por llamada, añadirlo pasó de sub-segundo
  a decenas de segundos en el lote, porque impide parar en la primera fila. Añade el paso previo
  que faltaba: medir cuántas filas puede devolver de verdad —aquí, cada entidad tenía exactamente
  un valor— y, si el no-determinismo es teórico, resolverlo con una restricción de datos o
  documentarlo con su cifra, no con un `ORDER BY` treinta veces más caro.
- **R-20** (grano más fino que la salida): **contraejemplo medido**. Conducir desde la tabla
  pequeña y convertir el detalle en `EXISTS` —el arreglo canónico de la regla— salió **peor** en
  lecturas y CPU sobre lotes idénticos. Motivo: obliga a decenas de sondas semi-join por llamada
  donde antes había un `seek` y un recorrido acotado ya cubierto por índice. Acota la regla a su
  caso real —el fan-out que se **colapsa** después con un `GROUP BY`— y no al que ya se corta
  solo con `TOP` o `EXISTS`.
- **R-28** (la instrumentación se audita): dos corolarios nuevos, ambos sobre Query Store.
  **(1)** El modo `AUTO` descarta las consultas triviales: la **ausencia** de un statement no
  prueba que no se ejecute, y en este objeto habría llevado a concluir justo lo contrario de lo
  que la regla advierte. **(2)** El instrumento se mide a sí mismo: una consulta de diagnóstico
  filtrada por un literal coincidió con su propio filtro y atribuyó sus lecturas de barrido sobre
  las vistas internas a la sentencia que pretendía medir —dos órdenes de magnitud de error,
  detectado solo al imprimir el texto capturado—.
- **Higiene**: fila nueva — el identificador de catálogo resuelto por su literal y degradado con
  `ISNULL(@id, -1)`. El `-1` convierte «no encontrado» en «no excluyas nada»: una corrección de
  traducción desactiva el filtro sin error y sin rastro. Agravante observado: en el mismo objeto
  dos estados iban escritos a mano y solo el tercero se buscaba por nombre.

**Lo que no se promovió:** el índice cuya clave es prefijo estricto del PK y el par de índices
exactamente duplicados — R-23 ya cubre ambas formas y el caso solo aporta magnitudes. La tabla de
detalle como HEAP con muchos RID lookups — R-24, sin mecanismo nuevo. Los `NOLOCK` sobre
catálogos diminutos — R-09. La columna sin calificar dentro de un join de dos tablas — ya está en
higiene. Tampoco se promovió nada sobre el reloj de pared como métrica: que fuera ruido entre dos
pasadas consecutivas del mismo lote es una observación metodológica de esta instancia, no una
regla de T-SQL.

---

## v5 — 2026-07-27 · Bloqueos en un procedimiento de captura con envío

**Origen:** incidente real de bloqueo en producción, reportado sobre un procedimiento largo que
concentra una docena de operaciones distintas seleccionadas por un parámetro numérico, con paso
de parámetros en cadena `clave=valor`. RCSI apagado, Always On. Medido en una copia **sin tráfico
del módulo**: no hubo captura del bloqueo en vivo, así que el diagnóstico se sostuvo en
estructura, volúmenes, política de escalada y la huella dejada en los datos.

Es la primera entrada del catálogo donde **el bloqueo y una pérdida de datos resultan ser el
mismo defecto**, y donde el hallazgo decisivo salió de los datos, no del código: el reparto de
una columna delató la sentencia culpable antes de que la lectura del código lo confirmara.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-29** Un identificador sin validar en el `WHERE` de una escritura masiva | Un parámetro que puede llegar con el centinela `0`/`''` usado tal cual en un `UPDATE`. El centinela no identifica una entidad: identifica el cajón de las que aún no la tienen. Medido: cientos de miles de filas en el centinela frente a una docena de media por identificador real, sobre una tabla con `lock_escalation = TABLE` — escalada a lock exclusivo de tabla **y** cientos de miles de filas inactivadas que nadie pidió inactivar. Trae la técnica de diagnóstico que lo destapó: comparar la bandera de baja contra su fecha, porque un `UPDATE` mal filtrado pone la bandera y deja la fecha vacía |

**Reglas reforzadas:**

- **R-26** (`XACT_ABORT`): pasa de `[gen]` a **`[obs]`** — primer caso observado. Varios
  `BEGIN TRAN` y cero `XACT_ABORT` en el mismo objeto, que sin embargo declaraba
  `SET ARITHABORT ON` dos veces seguidas. El matiz que aporta: no se omite por criterio, se
  omite porque no estaba en la plantilla de la que se copió el objeto.
- **R-10** (transacciones anidadas): sub-caso nuevo y de mucho impacto práctico — el `COMMIT`
  con `@@TRANCOUNT > 1` **sólo decrementa el contador**; no confirma ni libera un solo lock.
  Leído de arriba abajo el código parece cerrar pronto y no cierra nada. Con el corolario del
  `ROLLBACK` interno que revierte la transacción externa y hace fallar su `COMMIT` con error
  3902. Añade la regla de medición: la ventana de bloqueo se cuenta hasta el commit que deja
  `@@TRANCOUNT` en 0, no hasta el que se ve.
- **R-05** (`SELECT INTO`): sub-caso del catálogo materializado sin filtro — varias tablas de un
  catálogo geográfico volcadas enteras a tempdb para cruzarlas contra una docena de filas.
  Incluye por qué cuesta detectarlo en revisión: el `WHERE 1=1` de la subconsulta interior
  aparenta un filtro que no existe.

**Lo que no se promovió:** los hallazgos ya cubiertos sin matiz nuevo — `NOLOCK` decidiendo un
`INSERT` (R-09), predicado *catch-all* con función sobre la columna (R-06, R-01), parámetros en
cadena `clave=valor` (R-18), asignación de variable sin `TOP`/`ORDER BY` (R-12), `CATCH` sin
`THROW` (R-11). Tampoco las decenas de pasadas repitiendo la misma cadena de joins: es un caso
claro de trabajo repetido, pero no se midió su costo aislado, así que es una observación, no una
regla.

---

## v4 — 2026-07-24 · Revisión del dispositivo de captura de deadlocks

**Origen:** revisión de un job de análisis de deadlocks —herramienta de terceros, instalada en
`master`— sobre una instancia con Always On y RCSI apagado. No hubo incidente detonante: se
auditó el instrumento de diagnóstico, no el código de negocio. Es la primera entrada de este
catálogo que sale de auditar una herramienta de observación en vez de un procedimiento.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-28** La instrumentación de diagnóstico también se audita | Una fuente compartida tiene la retención que le deja su emisor más ruidoso. Medido: la inmensa mayoría de los eventos eran ajenos a lo que se buscaba, y la ventana real de retención en memoria y en disco era una fracción del uptime. El resultado es que **el vacío se lee como ausencia**: cero filas se interpreta como «no pasó nada» en vez de «la evidencia rotó». Trae los dos corolarios: lo que no se persiste no existe, y un job informa hacia atrás mientras una alerta avisa en el momento |

**Reglas reforzadas:**

- **R-25** (configuración por defecto): sub-caso medido del default que apaga la única captura
  nativa de bloqueo — `blocked process threshold (s) = 0`. La asimetría que lo hace importar:
  un puñado de deadlocks frente a horas de espera por bloqueo con casos individuales de decenas
  de minutos, y ni un registro de esto último. Incluye el criterio para elegir el umbral con la
  duración media medida de las esperas de lock.
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

**Origen:** auditoría de un procedimiento de alta frecuencia con decenas de joins que apareció
como participante en una cadena de bloqueo productiva. Always On, RCSI apagado.

**Reglas nuevas (7):**

| Regla | Por qué se añadió |
|---|---|
| **R-05** `SELECT ... INTO #temp` bloquea la instancia | Causa raíz del incidente. No estaba en el catálogo y es el mecanismo por el que un SP de **solo lectura** se vuelve cabeza de cadena |
| **R-06** Predicados catch-all | El detonante: plan compilado para un caso de 0 filas, reutilizado en uno grande |
| **R-13** `ORDER BY` en `SELECT ... INTO` se pierde | Defecto de correctitud introducido por una refactorización previa. Sobrevivió sin detectarse porque *a veces* el orden salía bien |
| **R-19** Table variables estiman 1 fila | Agravado por consultarlas desde un predicado no sargable |
| **R-20** No unir a un grano más fino que la salida | El `GROUP BY` de muchas columnas era el síntoma, no la causa |
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

**Origen:** análisis de código productivo — un conjunto de procedimientos, funciones, vistas y
triggers escritos por varios autores a lo largo de varios años. Los hallazgos reales se
destilaron en las reglas iniciales.

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
3. **Escribe la entrada** con la fecha, el origen en abstracto y la tabla de reglas nuevas y
   reforzadas. Sin cifras medidas ni descripción del entorno: el registro describe el patrón,
   no el caso (ver la política de anonimización en `SKILL.md`).
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
