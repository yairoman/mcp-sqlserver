# Registro de la base de conocimiento

Bitácora de cómo ha crecido este catálogo. Cada entrada dice **qué se añadió**, **de dónde
salió** y **qué lo motivó**, sin identificar el origen.

Sirve para tres cosas: saber si una regla lleva tiempo validada o es reciente, evitar volver a
añadir lo mismo con otro nombre, y ver qué patrones se repiten entre auditorías — que es la
señal de que son estilo del equipo y no descuidos.

---

## v17 — 2026-09-02 · 2.084 horas de CPU al mes leídas desde una copia

**Origen:** auditoría de una instancia de desarrollo de 56 bases refrescada desde producción.
El *restore* trajo dentro de cada base cuatro semanas de Query Store de producción —los planes
llevan grabados `engine_version` y `compatibility_level` del origen—, así que las cifras de coste
son de producción aunque se midieran en un entorno de pruebas: **17.907 millones de ejecuciones y
2.084 h de CPU en 28 días**, el 83 % en tres bases. La instancia estaba bien configurada y una
ventana viva de 60 s daba esperas al 11,7 % del tiempo de core: el coste era del código, no del
servidor. Además de Query Store se volcó el catálogo entero (8.131 tablas, 8.308 índices, 17.132
módulos, 3,13 millones de líneas) para cruzar el barrido estático con la CPU real por objeto.

**Dos reglas nuevas y cinco reforzadas.** El proceso de auditoría de instancia —paso 0 de
permisos, procedencia por `backupset`, rescate del Query Store antes de que se purgue, orden de
medición— se añadió al skill `analisis-bd`, que es donde vive el proceso.

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-42** Una poda que desactiva la integridad de toda la base para borrar en doce tablas | Dos jobs manuales de poda abrían con `sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL'` y `DISABLE TRIGGER ALL` sobre las **1.780 tablas** de la base, borraban en bucle con `DELETE TOP (50000)` —diez veces el umbral de escalado a lock de tabla— durante **8 h 58 m**, y cerraban con `WITH NOCHECK CHECK CONSTRAINT ALL`. Resultado medido: escrituras de **otras dos bases** sobre la podada esperaron **565 y 598 s** (una sesión murió esperando), y al terminar **1.040 FK** quedaron `is_not_trusted = 1`. La tabla más grande se podaba por una columna de fecha **sin índice**: cada lote escaneaba 2 GB con lock de tabla. R-04 y R-29 cubrían la transacción larga y el `WHERE` sin validar; ninguna cubría que el guion de poda desactive la integridad de toda la base ni que el tamaño del lote decida el ámbito del lock |
| **R-43** El mantenimiento de índices también es carga: un *rebuild* con *fallback* OFFLINE sobre una bitácora viva bloquea la aplicación | El job de mantenimiento de una base usaba `'INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE'`, que en el *framework* habitual significa «el primero que se pueda, y si no, el siguiente». Sobre una bitácora de 18,7 M filas con `INSERT` continuo desde la aplicación, el *rebuild* cayó a OFFLINE y los `INSERT` esperaron **2.521 s** a la hora exacta del job (lunes 21:00), dentro de una base que acumuló 5.184 s de esperas de lock en 48 h. El job coincidía además con la ventana de backups. En Standard Edition no existe ONLINE: allí el *fallback* no es una excepción, es el único camino, y la única salida es excluir las bitácoras del *rebuild* y mover la ventana |

**Reglas reforzadas:**

- **R-01** (función sobre columna): sub-caso con **trampa de equivalencia**. Reescribir
  `dateadd(YY, -1, col) < @d` como `col < DATEADD(YEAR, 1, @d)` es sargable y equivalente
  **salvo el 29 de febrero**: `DATEADD(YEAR, -1, '29-feb')` devuelve 28-feb y la desigualdad puede
  diferir para filas de ese día. La prueba de equivalencia debe ejecutarse con `@d` = hoy **y** con
  `@d` = 29 de febrero del último bisiesto, y la diferencia, si existe, es decisión de negocio, no
  del parche. Medido en un procedimiento de 28 ejecuciones y 3 h cada una, 86 h de CPU al mes.
- **R-02** (fila a fila): dos formas medidas que no estaban. (1) Una **función escalar en el
  `WHERE`** se ejecuta por cada fila candidata, no por cada ejecución: **5.823 millones** de
  llamadas en un mes desde 12.329 ejecuciones de un procedimiento que devolvía **3 filas**; 25 h
  de CPU la función y 81 h el llamador, con 40.500 millones de lecturas. La función devolvía 0 si y
  solo si no existía fila con dos tipos concretos: eso es un `NOT EXISTS` con `IN (a, b)`, un
  *anti-join* una vez por sentencia. (2) Un `WHILE` que hace `INSERT INTO #t EXEC otra_base.dbo.proc`
  por cada elemento: **148,9 millones** de llamadas al mes, 59 h. La suma de llamadas baratas es
  el coste; la detección es `count_executions` de la sentencia interior en Query Store, no la del
  procedimiento.
- **R-03** (triggers set-based): el molde que la regla describe apareció **51 veces** en tres
  bases, con una variante engañosa: el trigger **sí calcula** `@Count = COUNT(*) FROM inserted`,
  pero solo para decidir si la acción es I/U/D, y después hace `SELECT @id = col FROM deleted` y
  escribe una fila en una tabla de auditoría de otra base. Con N filas, la auditoría guarda una y
  pierde N−1, sin error. Ver `@Count` en un trigger no significa que esté protegido: hay que ver
  si se usa como guarda.
- **R-24** (heaps y bitácoras): el caso más caro no era una bitácora sino una tabla de 680.444
  filas y 51 MB **sin ningún índice**, borrada por dos columnas **8.939.526 veces al mes** a 36 ms
  cada una: **91 h de CPU** en escanear 51 MB. Sus tablas hermanas estaban agrupadas por esas dos
  columnas; una de ellas tenía **17 índices**. Y la magnitud en una instancia entera: **2.204 heaps,
  346 GB**, incluidos una bitácora de 50 GB (44,7 de LOB), una tabla de 76,7 M de filas al 67 %
  de fragmentación con la PK como índice no agrupado, y un histórico de 74,9 M de filas leído por
  el procedimiento de 3 h por ejecución.
- **R-39** (jobs): tres trampas hermanas de la que trae la regla. (1) **Cero fallos porque nunca
  corre**: cuatro jobs de mantenimiento habilitados **sin schedule**; la base más afectada tenía un
  índice al 99,4 % de fragmentación. (2) **88 fallos con una sola causa**: los jobs se clonaron de
  producción y el procedimiento que invocan no existía en la instancia; alguien creó una copia con
  otro nombre y reapuntó 18 de 23, y los 5 restantes siguieron fallando al 100 % durante semanas.
  La copia, además, perdió el registro de lo que ejecuta. (3) Agrupar los fallos por
  `job + paso + mensaje` convierte una lista de 108 fallos en cuatro causas en una consulta.

## v16 — 2026-09-01 · 194 mil millones de lecturas por un `OR` de once caracteres

**Origen:** análisis de un procedimiento de asignación disparado por un job cada 5 minutos, a
partir de una sesión observada con 278.881.161 lecturas lógicas y 14:54 transcurridos. La primera
medición descartó el diagnóstico intuitivo: **CPU al 95 % del tiempo transcurrido** — no estaba
bloqueada, estaba trabajando. El procedimiento observado resultó ser barato (2.278 lecturas por
ejecución); todo el coste estaba dos niveles por debajo, en una sola sentencia de un módulo
anidado de 3.777 líneas que acumulaba **194.529.462.857 lecturas lógicas en 32 días para devolver
14,3 filas de media**.

**Dos reglas nuevas y tres reforzadas.**

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-40** La recomendación de índice del motor es aritmética sobre las estadísticas que haya | La sugerencia con el *score* más alto de toda una base —impacto **76,5 %**— proponía indexar una columna bandera cuyo predicado selecciona el **96,8 %** de la tabla (934.367 de 964.966 filas). Las estadísticas que sostenían el cálculo tenían **ocho meses y medio** y muestreo del 6,8 %. La segunda sugerencia, con impacto **99,71 %**, pedía un índice sobre una columna que ya es la segunda del clustered. R-23 advertía que la DMV «sugiere columnas, no índices», pero no que su **cifra de impacto** hay que validarla contra la selectividad real antes de creerla |
| **R-41** Una verificación de equivalencia entre dos conjuntos vacíos pasa limpia | La primera pasada de la prueba de equivalencia dio `EXCEPT` cero en ambas direcciones **y cero filas en los dos lados**: habría pasado por buena. El lote se había tomado ordenando por clave ascendente, es decir las filas más antiguas, y un predicado de vigencia presente en ambas formas las descartaba todas. Aporta las dos mitades del arreglo: publicar el **conteo de cada lado** junto a las diferencias y tratar `filas = 0` como fallo, y **diseñar el lote** para que ejercite duplicados, valores fuera de rango y no-coincidencias — que es lo único que distingue un `LEFT JOIN + IS NOT NULL` de un `INNER JOIN` |

**Reglas reforzadas:**

- **R-06** (catch-all): sub-caso con **una forma distinta de las tres que traía la regla**. El
  `OR` no compara un parámetro con una columna: decide **si una tabla filtro participa**
  (`@lista = '' OR f.id IS NOT NULL` sobre un `LEFT JOIN`). El daño tampoco es el habitual —no es
  un plan mal *sniffed*, es que el filtro pequeño que ya está en la mano **no puede ser el lado
  conductor**, así que el plan arranca por el universo entero y descarta al final. Medido aislado,
  misma salida de 6 filas: **870.943 → 39** lecturas en una sentencia y **4.117.255 → 36** en la
  otra, factores de 22.332× y 114.368×. El reparto remata el caso: el **97 %** de las llamadas
  pasaba filtro concreto, es decir pagaba el plan del 3 %. Y dos señales de detección baratas: un
  `LEFT JOIN` con `IS NOT NULL` sobre esa misma tabla en el `WHERE`, y una consulta que acumula
  recompilaciones sin mejorar —13.907 compilaciones, dos planes cacheados y **los dos malos**, así
  que no había plan bueno que forzar.

- **R-02** (procedimiento en bucle fila por fila): sub-caso que **cambia la prioridad del
  arreglo**. Con Always On en `SYNCHRONOUS_COMMIT`, cada sentencia suelta del bucle es su propia
  transacción implícita y paga una espera de red. Medido: `HADR_SYNC_COMMIT` al **5,07 %** de todas
  las esperas de la instancia —1.455.868 tareas, 10.396.021 ms, **7,1 ms por commit**. Agrupar las
  escrituras del bucle quita CPU y latencia a la vez, sin tocar lógica de negocio: suele ser el
  cambio más fácil de justificar de todo el rediseño.

- **R-28** (auditar la instrumentación): dos trampas de lectura que dan cifras falsas sin error, y
  ambas se cometieron y corrigieron en esta misma investigación.
  `sys.dm_exec_procedure_stats` **incluye el costo de los módulos anidados**, así que sumar
  envoltorio e hijos duplica —se comprobó: 5.308.821.231 del padre contra 4.931.557.556 +
  377.093.875 de los hijos, exactamente lo mismo—, y la pista que lo delata es que comparten
  `execution_count` y `last_execution_time`. Y `EstimateRows` de un operador de scan **no es la
  cardinalidad de la tabla** sino la salida estimada tras los predicados: 284.863 estimadas sobre
  una tabla de 964.966, y 62.853 sobre otra de 628.533. Para volumen real,
  `sys.dm_db_partition_stats`.

- **R-23** (un índice de más también cuesta): sub-caso con **un coste que la regla no
  contemplaba**. Un índice muerto no solo cuesta escrituras: el optimizador usa cualquier
  estadística que cubra una columna para estimar cardinalidad, **la use o no el plan final**. Así
  que el histograma vencido de un índice con 37 seeks puede ser la fuente de la estimación de un
  predicado en consultas que ni lo tocan. Medido: 2 pasos de histograma sobre el 6,7 % de las filas,
  258 días sin actualizar. Es un argumento más para retirarlo, y uno contra crear índices «por si
  acaso»: cada uno añade una estadística que mantener y una fuente más de estimaciones malas.

**Lección de método, no de T-SQL:** tres de los hallazgos que este análisis publicó primero
resultaron equivocados al obtener acceso completo a las bases, y hubo que retirarlos —dos
recomendaciones de índice y un conjunto de cardinalidades leídas del plan. El patrón común es que
las tres eran **cifras derivadas** (un *score* de la DMV, un `EstimateRows`) tratadas como
mediciones. La regla que queda es la que ya estaba en `SKILL.md` y ahora tiene tres casos:
si no lo contaste, dilo como estimación.

---

## v15 — 2026-08-31 · Un servidor sin presión y con una sola sentencia leyendo 16 TB

**Origen:** revisión general de rendimiento de una instancia, sin incidente asociado. La
respuesta corta fue que la configuración estaba bien —`MAXDOP` y `cost threshold` ya ajustados,
memoria topada al 82 %, tempdb con 8 archivos iguales— y que todo el coste estaba en el código y
en un job. Las tres mediciones que descartaron el diagnóstico intuitivo: espera de señal al
**0,21 %**, concesiones de memoria pendientes en **0**, y **0** sesiones bloqueadas en la ventana
medida.

**Una regla nueva y cinco reforzadas.**

**Regla nueva:**

| Regla | Por qué se añadió |
|---|---|
| **R-39** Un job que no cabe en su propio intervalo no falla: deja de ejecutarse | Un job programado cada 5 min con duración máxima de **1.568 s** (26 min) y **0 fallos**. El Agent descarta los arranques solapados sin registrar nada: el proceso corre a un quinto de su ritmo y todos los paneles lo dan por verde. Aporta además dos cosas que no estaban en el catálogo: que la **media miente** —16 de 20 ejecuciones en 0–13 s y 4 en 1.100–1.314 s, un reparto bimodal que hay que separar entre *parameter sniffing* y volumen real antes de tocar nada— y la trampa aritmética de `run_duration`, que es `HHMMSS` y no segundos, así que un `AVG` sobre él no significa nada |

**Reglas reforzadas:**

- **R-19** (table variables): sub-caso que **corrige el alcance de la regla**. Estaba escrita
  alrededor de «en compat < 150 no hay *deferred compilation*», lo que se lee como que 150+ lo
  resuelve. No lo resuelve: la compilación diferida estima **una sola vez**, sin estadísticas y
  sin recompilar por cambio de volumen. Medido a **compat 160**: un `INSERT INTO @tabla` con
  **8.366.040** lecturas medias (≈ 64 GB por ejecución) y 4.519.397 ms de CPU en 17 ejecuciones —
  la sentencia más cara de la instancia. La nota operativa: al estimar la ganancia de subir el
  compat level, no cuentes las table variables como resueltas.

- **R-34** (duración ≫ CPU es espera): sub-caso nuevo con **la firma inversa**, que la regla no
  cubría. `CPU media > duración media` solo puede significar varios hilos, y el cociente aproxima
  el DOP efectivo. Dos sentencias de la misma instancia dieron **2,6×** las dos: un `INSERT` en
  table variable y un `IF EXISTS` que gastaba 2.829 ms de CPU por ejecución. El paralelismo
  encabezaba el ranking de esperas (`CXCONSUMER` al 27,67 %) y era el efecto, no la causa —
  estimación de cardinalidad equivocada. Subir `cost threshold` los habría sacado del informe sin
  arreglar nada.

- **R-14** (funciones escalares): **tercera reproducción** del sub-caso de la UDF que aparece dos
  veces en el plan cache, con cifras casi idénticas a la segunda —**69.205** ejecuciones del
  cuerpo en **173 segundos** frente a **1** de la consulta padre, y 144 M de lecturas contra
  147 M. Lo que aporta de nuevo, y contradice una lectura razonable de la regla anterior: la base
  estaba a **compat 160** y el inlining **no se aplicó**. Se añade la comprobación que lo zanja
  (`sys.sql_modules.is_inlineable`) y los dos descalificadores presentes en el caso: función
  declarada en otra base y cuerpo `SELECT TOP 1 @variable = …`.

- **R-25** (configuración por defecto): sub-caso nuevo, **la configuración por base**. La regla
  nació mirando `sp_configure`, que son diez valores en un sitio; el barrido de una instancia de
  52 bases encontró **10 sin `CHECKSUM`** (una de ellas en `NONE`), 1 con estadísticas
  automáticas apagadas, 1 con `AUTO_SHRINK` —en una base de bitácora— y 5 por debajo del compat
  del motor, 4 de ellas sin Query Store. Dos detalles que lo hacen regla y no anécdota: las bases
  afectadas **no eran las dormidas** —dos encabezaban el consumo—, y la herramienta de auditoría
  de configuración **abortó con error 916** en la primera base sin acceso devolviendo cero
  hallazgos, mientras el barrido por `sys.databases` lo encontró completo. Se añade además la
  advertencia de que `PAGE_VERIFY CHECKSUM` solo protege lo que se escriba a partir de ese
  momento: prometer que el `ALTER` cierra el riesgo es falso.

- **R-28** (la instrumentación se audita): segunda reproducción del sub-caso «el instrumento *es*
  el consumo», por una vía distinta y por eso vale la pena. Aquí el colector no salió en el
  ranking de CPU sino en el de **esperas**: `MSQL_XP` era la segunda de la instancia, **6 h 50
  min** sobre 69 h de uptime. Ninguna consulta de negocio lo explicaba, y el rastro no estaba en
  `dm_exec_query_stats` sino en los `usecounts` del plan cache. Se añade la heurística —`MSQL_XP`
  y `PREEMPTIVE_OS_*` sin dueño apuntan a un agente externo— y la consulta que lo identifica.

**Revisado y sin cambios:** R-09 (`NOLOCK` sistemático en las cuatro bases principales, incluido
el interior de la UDF — la regla ya lo cubre y aquí quedó marcado como decisión funcional, no
como defecto a corregir), R-32 (el `IF EXISTS` sin índice de apoyo es el caso de manual), R-23
(no se pudo aplicar: sin acceso a las bases no hay forma de ver índices redundantes) y R-06.

**No promovido por no estar verificado:** la causa concreta de la bimodalidad del job de R-39.
Distinguir *parameter sniffing* de volumen real exigía instrumentar el número de filas por
ejecución, y la sesión fue de solo lectura. Queda anotado en el informe como el primer paso del
arreglo, no como hallazgo.

**Límite de la investigación, que condiciona todo lo anterior:** el login solo accedía a **26 de
52 bases**, y a ninguna de las que encabezaban el consumo. Las DMV de ámbito de servidor sí
respondían, así que se midió el *qué* pero no el *dónde*: sin definición de objetos, sin índices
existentes y sin volúmenes de tabla. Por eso los índices candidatos se entregaron **comentados**,
tras una comprobación previa obligatoria, en vez de como script aplicable.

---

## v14 — 2026-08-17 · El `DELETE` de la alerta no era el que bloqueaba

**Origen:** dos alertas de bloqueo en producción el mismo día, ambas con el mismo par: un paso de
job de SQL Agent —comando `DELETE`— reteniendo a un proceso de aplicación en `UPDATE`. La lectura
intuitiva era que el `DELETE` bloqueaba. Era falsa: los `DELETE` del proceso iban **todos contra
tablas temporales**. Lo que bloqueaba eran los locks acumulados por los `INSERT` anteriores,
retenidos porque una transacción abierta al principio del bucle no confirmaba hasta el final —
medido, **3.328 s** en la corrida pesada.

**Dos reglas nuevas y tres reforzadas.**

**Reglas nuevas:**

| Regla | Por qué se añadió |
|---|---|
| **R-37** Una reescritura equivalente puede costar 48 veces más | El catálogo ya exigía demostrar que una reescritura no cambia el resultado; faltaba la otra mitad. Sacar una condición de la tabla externa fuera de un `NOT EXISTS` es estrictamente equivalente con la columna `NOT NULL`, y midió **179 ms → 7.311 ms**. Se descartó el cambio. Aporta además el método: ejecutar aisladas, repetir contra la caché, y documentar el descarte con su cifra |
| **R-38** Código ejecutable guardado como datos no existe para el motor | 39 scripts de 10 a 82 KB viviendo en filas de una tabla. `sys.dm_sql_referencing_entities` devolvía **0 filas** y `sys.sql_modules` encontraba **1 objeto** donde en realidad 39 scripts escribían en tablas de 3,16 M y 7,7 M. El mapa de dependencias previo a un `sp_rename` sale limpio y es falso |

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
  conviene interiorizar: la duración deja de correlacionar con el volumen. Mismo día, misma
  instancia: 3.445 filas encoladas en 3.328 s, y **10 filas en 2.714 s**. Un `BEGIN TRAN` cuyo
  coste no correlaciona con el trabajo útil no se ajusta, se acota.

- **R-11** (un `CATCH` vacío es un error que nadie verá): sub-caso desde el lado del llamador.
  `IF @@ERROR <> 0` después de un `EXEC` es una comprobación que **parece** existir: si el código
  ejecutado trae su propio `TRY/CATCH` y no relanza, `@@ERROR` vale 0. Medido: **12 de 39**
  scripts lo traían, y el job cerraba informando de que todo se había ejecutado correctamente.
  Se enlaza con R-26 por el segundo fallo del mismo patrón: sin `XACT_ABORT`, el bucle sigue con
  la transacción abierta.

**Revisado y sin cambios:** R-01 (el `CONVERT(VarChar(8), Fecha, 112)` sobre un heap de 1,42 M
filas es el caso de manual, ya cubierto), R-23 (índice sin uso y redundante por prefijo — la regla
ya advertía de comprobar los días de arranque antes de un `DROP`, y aquí eran 5), R-24 (heaps
grandes) y R-32.

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
hueco estructural de observabilidad. Query Store registraba esperas por lock de **20,5 s**, dos
madrugadas consecutivas a la misma hora y con el mismo `query_id`, pero no puede nombrar al
bloqueador. El job de vigilancia sí lo nombra, y sin embargo no había registrado nada: en **14
días** solo tenía **2 episodios**, ambos ruido. Ninguna de las dos herramientas fallaba; las dos
medían fuera de la banda donde ocurrían los hechos.

**Una regla nueva y dos reforzadas.**

**Regla nueva:**

- **R-36** (`READPAST` en una escritura salta filas en silencio). Es idiomático en la *lectura* de
  una cola y un defecto en la *escritura*: el motor omite las filas bloqueadas, devuelve un
  `@@ROWCOUNT` menor y no avisa. Lo que le da la severidad es la combinación con el guard de
  «trabajo en vuelo» (`IF EXISTS (... estado = 1) RETURN`) que acompaña a estos procesos: **una
  sola fila atascada detiene la cola completa, de forma permanente y silenciosa**, con el job
  reportando éxito. Medido sobre una tabla de cola de **43.650 filas**. Es un interbloqueo lógico
  que ninguna herramienta de bloqueo detecta, porque no hay ningún lock esperando a nadie.

**Reglas reforzadas:**

- **R-04** (transacciones cortas, nunca envuelvan trabajo externo): sub-caso nuevo, **la llamada
  HTTP síncrona dentro de la transacción**. «Trabajo externo» se venía leyendo como *otro
  procedimiento*; el que de verdad hace daño es la salida a la red. Un procedimiento de cola abría
  `BEGIN TRANSACTION` y dentro hacía un `POST` con `sp_OACreate 'MSXML2.ServerXMLHTTP'`: la
  duración del lock la decidía un servidor web. **20.517 ms y 18.861 ms** medidos en dos
  madrugadas. Y el agravante que convierte lo crónico en incidente: el objeto COM se instanciaba
  **sin `setTimeouts`**, así que el peor caso no estaba acotado por nada. Aporta la mitigación
  barata para cuando el rediseño no cabe todavía, y la consulta de detección por
  `sp_OACreate`/`ServerXMLHTTP` más el interruptor de instancia que lo habilita.

- **R-28** (la instrumentación de diagnóstico también se audita): dos corolarios nuevos.

  El primero, **el suelo de detección de un monitor por muestreo**. Si la regla de disparo exige
  ver el síntoma en N muestras consecutivas, el umbral real es `(N-1) × intervalo`, no el
  intervalo. Medido: muestreo cada **5 min** con disparo a la segunda foto ⇒ suelo efectivo de
  **5 minutos**, contra eventos reales de **1 s a 5 min**. El instrumento no fallaba: empezaba a
  medir justo donde terminaban los hechos. Con el agravante de segundo orden de que un monitor que
  solo alerta por ruido acaba ignorado, lo que deja el hueco sin cubrir *y* sin que nadie lo note.

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

**Origen:** continuación directa de v11. El benchmark de migración detectó que el paralelismo era el
74 % de la espera de la instancia y lo localizó en una base que aquel trabajo no había auditado: el
**0,065 % de sus ejecuciones consumía el 53,6 % de su CPU**. Al abrir el segundo consumidor —un
proceso diario de sustitución de auditorías, ~600 líneas, 14 tablas temporales, 38 `NOLOCK`, cuatro
bases referenciadas— la investigación de rendimiento se convirtió en otra cosa.

**Ninguna regla nueva; una reforzada a fondo y tres entradas de higiene.** El hallazgo no necesitaba
un número propio: es R-29 —escritura masiva fuera de alcance— llegando por un camino que la regla no
contemplaba.

**Regla reforzada:**

- **R-29** (identificador sin validar en una escritura masiva): sub-caso nuevo, **la precedencia de
  `AND` sobre `OR`**. Hasta ahora la regla cubría el valor centinela; aquí las condiciones de alcance
  estaban todas escritas y correctas, pero **sin paréntesis**, de modo que el motor evaluaba
  `(A AND B AND C AND D) OR (E OR F)` y cualquier fila que cumpliera `E` se saltaba el filtro de
  lote y la marca de baja. Medido sobre una tabla de **1.249.450 filas** con 48 lotes: el `UPDATE`
  tocaba **58.910 filas en vez de 4.992** —doce veces el alcance—, de ellas **32.338 marcadas como
  inactivas**, y alcanzaba **los 48 lotes** en lugar de uno. En un proceso diario que **sobrescribe
  columnas en vez de insertar filas**, así que no deja rastro propio.

  Aporta además el agravante que lo mantuvo invisible durante quién sabe cuánto: en el mismo `WHERE`,
  una condición escrita `col = 'PREFIJO%'` en lugar de `LIKE` coincidía con **0 filas** donde debía
  coincidir con **39.988**. **Los dos defectos se tapaban entre sí** —uno ampliaba el alcance, el
  otro apagaba la condición que lo habría hecho notorio— de modo que el resultado nunca fue lo
  bastante raro como para que alguien lo mirara. De ahí la instrucción operativa: cuando encuentres
  uno de los dos, busca el otro en la misma cláusula.

**Higiene — tres entradas nuevas:**

- **`=` con comodín** (`col = 'PREFIJO%'`). El inverso del `LIKE` sin comodines que ya estaba, y el
  peligroso de los dos: no da error, solo devuelve cero filas. 0 contra 39.988, repetido 3 veces en
  el mismo objeto.
- **`DELETE`/`UPDATE` con `LEFT JOIN` y `WHERE col NOT IN (...)`**. Doble fallo con `NULL`: el
  `LEFT JOIN` degenera en `INNER JOIN`, y un solo `NULL` en la subconsulta hace que no se borre nada.
- Ambas se detectan comparando conteos, que es lo que las hace baratas de auditar.

**Lo que no se promovió, y por qué.** El resto de hallazgos del caso ya estaban cubiertos y no
aportaban sub-caso: la tabla de 1,25 M de filas con **cero índices no agrupados** consultada 8 veces
por columnas que la clave agrupada no cubre es R-32 literal; los 38 `NOLOCK` en lecturas que deciden
escrituras son R-09; el `TOP 1` sin `ORDER BY` que elige el lote a procesar es R-12; las 14 tablas
temporales sin índice son R-16; los **16 de 36 índices sin una sola lectura** son R-23 —con su
límite bien puesto: 66 h de medición no descartan un índice mensual—. Que seis reglas distintas
aparezcan juntas en un solo objeto es, en sí, la observación de la v1: no son descuidos aislados,
son el estilo por defecto.

**Y una nota metodológica que confirma v11.** Este objeto se localizó porque el delta de esperas de
la instancia contradijo la conclusión sacada de Query Store de una sola base. La regla añadida
entonces —*el alcance de la evidencia tiene que cubrir el alcance de la afirmación*— es lo que hizo
posible este trabajo tres horas después.

---

## v11 — 2026-08-11 · «Migramos el fin de semana, ¿es mejor?»

**Origen:** benchmark post-migración de dos versiones mayores, pedido tres días después del
cambio. 49 bases restauradas en un fin de semana sobre un servidor nuevo —8 núcleos, 45 GB,
Developer, **RTM sin ningún CU**, Always On— con **63 h de uptime** al medir. Solo lectura, sin
permiso `SHOWPLAN` y sin acceso a `msdb`. Es la primera entrada de la serie que **compara dos
instancias distintas**, y solo fue posible porque Query Store viaja dentro del backup: el
historial de 30 días medido en el motor viejo llegó con las bases.

**Una regla nueva y una reforzada.** Lo que distingue esta entrada es que el resultado contradecía
la intuición en las dos direcciones. Se esperaba «la versión nueva es más rápida» y se midió
**×1,76 de duración**; se dedujo entonces «el hardware nuevo es peor» y resultó ser **mejor**: las
mismas consultas leían un **26 % menos páginas** y el disco respondía en **0,48 ms**.

**Regla nueva:**

- **R-35** (una migración mueve los datos, no la puesta a punto). Aporta cuatro cosas.
  **(1)** El inventario de qué viaja dentro del backup, qué se queda y qué se resetea — y por qué
  lo que viaja es lo peligroso: las estadísticas llegan **con su `modification_counter` intacto**,
  así que parecen correctas por el mero hecho de estar. Medido: **2.190 de 2.331** estadísticas
  con más de 30 días, **39 con más modificaciones pendientes que filas tiene la tabla**, máximo de
  **241 días** y muestreos del **1,6 %**. **(2)** La firma diagnóstica, que es lo que hace la regla
  memorable: **menos lecturas y más tiempo** no es hardware peor, es hardware mejor ejecutando
  planes peores. **(3)** El control que lo demuestra —aislar las consultas cuyo I/O no cambió
  (±5 %)—, que acotó la parte atribuible al servidor a un **17–33 %** con la mayoría sin cambio, y
  sin el cual el informe habría culpado a la máquina nueva. **(4)** El orden de remediación:
  estadísticas primero, CU después, compat level al final, porque subir el compat con histogramas
  de 241 días es evaluar un optimizador nuevo con datos falsos.

  El coste del compat level quedó cuantificado y deja de ser un argumento teórico: **43 de 45
  bases** seguían en el nivel del motor anterior, y una sola base tenía **176 funciones escalares y
  46 TVF multi-sentencia frente a 9 TVF inline** — con **cuatro funciones escalares entre los
  objetos más degradados**, una de ellas con **1.130.562 ejecuciones diarias**. Es exactamente lo
  que el compat nuevo resuelve sin tocar T-SQL (R-14, R-19), y estaba desactivado.

  Se descartó por medición la hipótesis intuitiva: `cost threshold` había caído de 50 a 5 en la
  instancia nueva, pero el paralelismo era **0,016 %** de las ejecuciones frente al 0,005 % previo.
  La regresión de configuración es real y se documentó (R-25), pero no era la causa.

**Regla reforzada:**

- **R-28** (la instrumentación se audita): sub-caso nuevo y de aplicación general — **la
  herramienta del que mira**. Hasta ahora la regla cubría el instrumento propio auto-capturándose;
  aquí el ruido lo mete otra persona con SSMS abierto. Las **dos consultas con peor regresión de
  todo el conjunto** (**×10,71 y ×38,69**, con el I/O pasando de 931 a 5.909 y de 400 a 4.968)
  eran del **Object Explorer** —firma `@_msparam_n` sobre alias `clmns`—, y encabezaban el ranking
  precisamente porque nadie navegaba ese servidor antes de migrarlo. Publicadas sin filtrar habrían
  descrito una degradación muy superior a la real. Queda el filtro
  (`NOT LIKE '%msparam%'`), la separación por `object_id` entre código del negocio y ad-hoc, y la
  regla general que las engloba a todas: **antes de dar por buena una consulta de la lista de
  peores, lee su texto**.

**Lo que no se promovió.** Los 25 índices que el motor recomendaba: se acumularon en 63 h y con las
estadísticas obsoletas descritas en R-35, de modo que son propuestas para compensar estimaciones
falsas. Medirlos de nuevo tras actualizar estadísticas es parte del plan de acción, no una regla.

### Adenda — la primera ejecución del script de verificación corrigió el informe

Tres horas después de entregar el paquete, el cliente ejecutó `99_verificacion.sql` y devolvió su
salida. Esa segunda captura, restada de la primera, **invalidó una conclusión y destapó un defecto
en la propia métrica de seguimiento**. Ambas cosas se promueven a **R-28**, que gana tres
sub-casos más:

- **La media sobre una población que crece deriva sola.** El informe proponía seguir
  «0,975 ms → objetivo 0,700 ms». En 3 h **sin aplicar nada**, esa cifra bajó a **0,733 ms**: la
  población comparable había pasado de **301 a 482 consultas** al acumular ejecuciones, y las
  nuevas eran más baratas. Un 25 % de mejora inexistente. **El factor, en cambio, no se movió:
  ×1,76 → ×1,74.** De ahí la regla: la métrica de un antes/después es el **cociente de cada
  consulta contra sí misma**, nunca el agregado absoluto. Se añade también la **caducidad**: la
  ventana «antes» muere con la retención de Query Store, así que o se exporta o la medición deja
  de poder rehacerse.
- **Query Store es por base; las esperas son de la instancia.** El error propio, y el más
  instructivo. Del 0,016 % de ejecuciones paralelas en la base auditada se concluyó «paralelismo
  descartado». Dato correcto, conclusión falsa: el delta de esperas de la **instancia** puso
  `CXCONSUMER`+`CXSYNC_PORT`+`CXPACKET` en el **74 % de la espera real**, originado en otra base de
  las 49. Antes de descartar un mecanismo, comprobar que el alcance de la evidencia cubre el
  alcance de la afirmación.
- **Un porcentaje de ejecuciones no mide un porcentaje de coste.** En la base culpable, el
  **0,065 % de las ejecuciones consumía el 53,6 % del CPU**: doce sentencias, la primera con
  **326.997.111 lecturas lógicas por ejecución** y 2.907 s de CPU en **dos** ejecuciones. Con el
  corolario que evita el arreglo equivocado: subir `cost threshold` frena lo trivial, no lo que
  cuesta órdenes de magnitud más que el umbral.

**Y una lección de proceso, sin regla propia:** el script de verificación no es papeleo de cierre.
Aquí fue el instrumento que corrigió el informe que lo acompañaba, tres horas después de
entregarlo. Un paquete sin `99_verificacion.sql` habría dejado las tres conclusiones erróneas en
pie indefinidamente.

---

## v10 — 2026-08-06 · «Va muy lento desde hace dos días»

**Origen:** reporte de usuarios, sin objeto señalado y sin más pista que la fecha. Misma
instancia que v9 —8 núcleos, 43 GB, SQL 2016 SP3 Developer, compat 130—, ahora con 63 días
encendida. Solo lectura, **sin permiso `SHOWPLAN`**. Query Store estaba activo en
`READ_WRITE` con 30 días de retención en las cuatro bases calientes, y **es la razón por la que
esta investigación pudo concluir algo**: sin él, el hallazgo principal no era demostrable.

**Una regla nueva y dos reforzadas.** Lo que hace distinta esta entrada es el error que estuvo a
punto de cometerse. Las tres primeras horas apuntaban a los dos consumidores de CPU más obvios
—un colector de monitorización y la limpieza de Change Tracking de una base recién clonada—,
ambos reales, ambos fechados dentro de la ventana reportada, ambos con cifras espectaculares. La
medición de CPU los descartó como causa del síntoma: **13 % de media y cero minutos por encima
del 80 %**. Un servidor ocioso no explica usuarios parados; lo explica un servidor **esperando**.

**Regla nueva:**

- **R-34** (una consulta lenta con CPU casi nula está esperando). Seis sentencias de pantallas
  de búsqueda con **22.141 ms de duración media contra 0,4 ms de CPU y 6 lecturas lógicas** —una
  relación de **55.000×**—, incluido un `INSERT` de una fila en una tabla de 4 MB que tardaba
  23,7 s. Aporta cuatro cosas: **(1)** el razonamiento aritmético que cierra el diagnóstico sin
  necesidad de capturar el bloqueo, porque una sentencia que toca 6 páginas no puede tardar 22 s
  por sí misma; **(2)** la inversión de la lectura habitual — **la CPU baja del servidor es el
  síntoma, no la prueba de salud**; **(3)** por qué las DMV de sesión no valen aquí: un muestreo
  de 31 s registró **0 ms** de bloqueo y las cadenas salieron limpias con el problema activo, así
  que sólo Query Store, que conserva duración **y** CPU, permite el diagnóstico a posteriori; y
  **(4)** la tabla de descartes —cliente que no consume, consulta remota, espera por memoria—,
  sin la cual la regla sería una corazonada. Con `RCSI` apagado en 8 de 8 bases y
  `lock_escalation = TABLE` en 13 de 13 tablas, el mecanismo queda cerrado.

**Reglas reforzadas:**

- **R-25** (configuración por defecto): **tercera aparición** de los 365 días de Change Tracking,
  y por fin con el mecanismo de propagación visible. Una copia de base heredó **72 tablas con CT,
  759 MB de tablas laterales, 18.177.132 filas y la retención completa**, duplicando el coste de
  limpieza de la instancia al mismo ritmo exacto de 144 ejecuciones/hora. Que reaparezca por
  tercera vez ya no es un descuido: es lo que pasa por defecto al clonar. Se añade además la
  **técnica de fechado** que resolvió la investigación — cruzar `creation_time` del plan cache
  contra `create_date` de `sys.databases` fechó el cambio con **14 minutos** de precisión, sin
  depender de que nadie recordara qué se hizo.
- **R-28** (la instrumentación se audita): dos sub-casos. El primero invierte la regla —hasta
  ahora trataba la instrumentación como fuente que se degrada; aquí **era el consumo**: una
  métrica de monitorización interrogando el historial de respaldos cada 10 s se llevaba
  **80.377,8 s de CPU y 20.000 millones de lecturas en 66 h**, recorriendo 98 veces por ejecución
  una tabla de 67 MB. Con el corolario que lo hace invisible: esas filas tienen `dbid` nulo y se
  caen de todo informe ordenado por base. El segundo es metodológico y de aplicación general:
  **las esperas acumuladas no pueden fechar una regresión** —63 días de uptime diluyen dos días
  por un factor de 30—, y lo que sí funciona son dos capturas restadas (`CXPACKET`+`CXCONSUMER`
  al **84 %** en una ventana de 31 s, frente al 11,5 % del acumulado) y Query Store agregado
  **comparando laborables contra laborables**, que dio 1,10 ms → 1,89 ms por sentencia y señaló
  el día. Contrastar una segunda base descartó la causa de instancia: la vecina no se movió.

**Lo que se decidió NO promover.** El entorno tenía material de sobra —97,1 % de lotes provocando
compilación, 55 h de CPU compilando en 30 días en una sola base, un `UPDATE` entre bases con 11
planes distintos en 9 días (de 1,6 ms a 597.892 ms), 172 triggers, 21 sesiones abandonadas—. Nada
de eso subió al catálogo: o ya está cubierto por R-06, R-19 y R-23, o no se pudo medir su efecto
sobre el síntoma reportado. **Un consumidor grande no es una causa mientras no se demuestre que
alimenta el síntoma**, que es precisamente la lección de esta entrada.

---

## v9 — 2026-07-31 · «¿Y esto hará que la web vaya más rápida?»

**Origen:** continuación directa de v8. Cerrado el plan de poda, la pregunta del cliente fue si
serviría para acelerar los aplicativos web. La respuesta medida fue que no, y esa negativa abrió la
investigación útil: entonces **qué sí**. Instancia de 8 núcleos, 43 GB, 58 días encendida, SQL 2016
SP3 Developer, compat 130. Análisis en solo lectura, **sin permiso `SHOWPLAN`**: ningún hallazgo se
apoya en un plan de ejecución.

Ninguna regla nueva: las cuatro reglas que cubren este terreno ya existían y todas salieron
reforzadas con evidencia de otro tipo. Dos cosas hacen esta entrada distinta.

**La primera: la configuración crítica ya estaba corregida.** `cost threshold` en 50, `MAXDOP` 4
sobre 8 schedulers, `optimize for ad hoc` activo. Es la segunda vez que este catálogo se encuentra
un entorno así (ver v7), y la lección se repite: cuando los parámetros están bien, lo que queda es
código, y conviene decirlo pronto para que nadie siga buscando el interruptor mágico.

**La segunda: la conclusión de v8 quedó confirmada por un camino independiente.** v8 dedujo que
podar no aceleraría la aplicación mirando el **uso de índices**. v9 llegó a lo mismo mirando las
**esperas**: `PAGEIOLATCH_SH` al 0,12 % frente al 12,14 % de paralelismo. Dos evidencias
inconexas apuntando al mismo sitio valen mucho más que una.

**Reglas reforzadas:**

- **R-33** (reducir volumen no es optimizar): la **comprobación de dos minutos** que decide la
  conversación entera, y que va antes que el uso de índices. `PAGEIOLATCH_*` cien veces por debajo
  del paralelismo prueba que la instancia no espera por disco, y una base más pequeña solo ahorra
  E/S. Se anota también el recíproco, que es la única forma honesta de rescatar el argumento
  contrario: si `PAGEIOLATCH_*` sí pesa, la reducción de volumen vuelve a la mesa. Y el
  `SOS_SCHEDULER_YIELD` con **99,85 % de espera por señal** como indicador de presión de CPU.
- **R-14** (funciones escalares): el sub-caso de la **cadena**. La función medida llamaba a otras
  dos funciones escalares, de modo que una invocación disparaba **hasta 4 consultas**, una vez por
  fila. Trae tres cosas nuevas: **(1)** el descarte que ahorra semanas — las cinco tablas
  recorridas sumaban 127 MB, ninguna llegaba a 79.000 filas y los índices exactos ya existían, así
  que el problema era el número de invocaciones y ningún índice lo iba a arreglar; **(2)** el
  alcance aparente engaña — una de las funciones de apoyo tenía **54 referencias**, pero con
  sufijos `_BkUp`, `_notused`, `_Test`, `_prueba` y cinco con fecha en el nombre; **(3)** la receta
  de reescritura verificada con `EXCEPT` en ambas direcciones, **0 diferencias en 3.000 casos**, y
  su medición: **3.000 filas en 26.950 ms** por la vía escalar frente a **71.218 en 568 ms** por la
  de conjunto. Con la advertencia de que no es un reemplazo transparente: cambia la forma de
  invocar, así que hay que editar cada llamador.
- **R-28** (la instrumentación se audita): el **caso inverso** de la regla. Hasta ahora recogía
  «el vacío se lee como ausencia»; aquí **el ruido se lee como señal**. Las cinco esperas mayores
  de `sys.dm_os_wait_stats` sumaban el **80,2 %** y ninguna era contención: sin filtrar, el
  diagnóstico habría sido «esta instancia espera por Always On». Se añade la exigencia de mirar el
  *signal wait* y el número de tareas, y una trampa aparte: **los totales del plan cache no cubren
  el uptime** —`sys.dm_exec_query_stats` acumula desde `creation_time` de cada plan—, así que en
  una misma foto convivían una fila con 3 días de historia y otra con minutos.
- **R-25** (configuración de la instancia): confirmación de que 4 de los 5 parámetros críticos
  estaban ya en su sitio, y que el que faltaba era otra vez `blocked process threshold` en **0**.
  Refuerza el sub-caso que ya recogía la regla: es el parámetro que nadie toca, y sin él no hay
  forma de saber quién bloqueó a quién cuando alguien reporte que la aplicación se quedó colgada.

**Lo que se decidió NO promover:**

- Encender RCSI. Es casi con seguridad la razón de fondo de los `NOLOCK` que aparecen en todo el
  código revisado, pero proponerlo desde un entorno de desarrollo sería exactamente el error que
  R-33 y v8 documentan: se decide sobre producción, con la medición de tempdb delante, y se replica
  hacia abajo. Queda como pendiente en el informe, no como propuesta.

## v8 — 2026-07-30 · Reducir una copia de producción en un entorno de desarrollo

**Origen:** plan de poda de una base de **305,72 GB usados** (345,90 asignados) restaurada desde
producción a una instancia de desarrollo, con el objetivo de conservar solo los últimos 5 años.
1.773 tablas, 1.096 FKs (132 no confiables), **432 heaps con 125,66 GB**, 554 índices no
clusterizados con 96,40 GB, 3.758 procedimientos. SQL Server 2016 SP3, compat 130, Developer
Edition, RCSI apagado, recovery `FULL` en un entorno de desarrollo. Análisis en solo lectura.

Lo que hace distinta esta entrada: **la premisa de la que partía el trabajo era falsa, y medirla
antes de planificar cambió el orden de todo el plan.** Se pedía una restauración parcial por
fecha; `RESTORE ... WITH PARTIAL` opera sobre *filegroups* y la base tenía uno solo, sin
particionamiento. Descartada esa vía, la pregunta pasó a ser cuánto libera el corte de 5 años — y
resultó que **38,38 GB de la base no eran datos de ninguna antigüedad, sino páginas vacías**. La
segunda tabla más grande, 24,82 GB, solo contenía cuatro meses y medio de historia: el corte por
fecha no le quitaba ni una fila.

**Ampliación del 2026-07-31.** El trabajo estaba cerrado cuando llegó la pregunta que lo puso a
prueba: *¿esto hará que los aplicativos web vayan más rápido?* Medirlo cambió la conclusión del
informe y produjo la única regla nueva de esta versión. Las tablas que concentraban los 119 GB
recuperables registraban **0 búsquedas de la aplicación en 57 días** —solo escrituras—, y la
única que la aplicación castigaba de verdad acumulaba **19.642.060 búsquedas y 0 escaneos**.
La poda seguía justificándose por espacio, backup y tiempo de refresco; por rendimiento, no.

**Regla nueva (1):**

| Regla | Por qué se añadió |
|---|---|
| **R-33** Reducir volumen no es optimizar | El coste de una búsqueda en un índice es **logarítmico** respecto al número de filas y el de un escaneo es **lineal**: toda la ganancia de una reducción de datos se concentra en lo que hace escaneos, y si nada escanea la tabla la ganancia es cero. Medido: 5 tablas candidatas con 48,00 / 24,82 / 12,87 / 10,99 / 3,78 GB y **0 búsquedas** entre todas; una de ellas con **263.185 escrituras y 0 lecturas**. Trae una trampa de método que casi invierte el diagnóstico: **las consultas del propio análisis contaminan `dm_db_index_usage_stats`** — los únicos escaneos registrados llevaban marca de tiempo dentro de la ventana en que se corrieron los `COUNT(*)` de la auditoría, y sin mirar `last_user_scan` se habría concluido que la aplicación sí las lee. Y deja escrito qué **sí** compra una poda —backup, restore, `CHECKDB`, ciclo de refresco, disco—, que es operación y no experiencia de usuario |

Los dos hallazgos de la primera pasada, en cambio, son sub-casos de reglas que ya existían: señal
de que el catálogo va cubriendo el terreno.

**Reglas reforzadas:**

- **R-24** (heaps y bitácoras): el sub-caso **aritmético**, que no necesita ninguna DMV para
  detectarse. `Paginas * 8192.0 / Filas` dio **81.528 bytes por fila** en una tabla sin columnas
  LOB — diez veces el máximo de 8.060 que cabe en una fila. Solo puede ser espacio muerto:
  3.252.900 páginas al **1,88 % de ocupación** para 326.677 filas, confirmado con
  `avg_page_space_used_in_percent` en modo `SAMPLED` (`LIMITED` devuelve `NULL` ahí). El coste en
  tiempo también se midió: **27 segundos para contar 326.677 filas**. Trae tres corolarios que
  rompen planes de trabajo: **(1)** una poda por antigüedad sobre un heap no libera un byte sin
  `REBUILD` posterior, así que toda estimación de ahorro que lo omita es ficción; **(2)** antes de
  cortar por fecha hay que comprobar que la columna está poblada — una bitácora de **87.368.562
  filas** tenía la suya en `NULL` en el **100 %**, y otra tabla mezclaba fechas de **1900** y
  **8202**; **(3)** el peso no está donde están las filas: la mayor tabla tenía 2,79 M de filas y
  **42,79 de sus 48 GB en unidades de asignación LOB**, lo que cambia qué técnica de borrado
  conviene.
- **R-22** (conversión implícita): el sub-caso de **modelo**, no de parámetro. La misma clave
  lógica declarada `varchar(36)` en dos tablas y `uniqueidentifier` en una tercera de 10,83 GB,
  **sin una sola FK entre las tres**. Coste medido sobre el mismo corte: **14,5 s** con conversión
  frente a **5,0 s** entre las que comparten tipo. La relación se sostenía por convención: una
  muestra de 20.000 filas emparejó el **99,8 %**, y el 0,2 % restante eran huérfanos que ninguna
  restricción impedía. Corolario: comprobar el tipo en **toda** la cadena de tablas, no solo en
  las dos que se están mirando, y medir cuántas filas emparejan cuando no hay FK que lo garantice.

- **R-25** (configuración de la instancia): **Change Tracking, por segunda vez y en otra
  instancia**, otra vez con 365 días de retención y otra vez como **el mayor consumidor de CPU
  del servidor entero**: 9.161.864 ms —2 h 33 min— en 11.304 ejecuciones y 107.469.831 lecturas,
  y esas cifras cubrían **3 días**, no el uptime. Habilitado en 4 bases con retenciones de 3, 7 y
  365 días conviviendo. Que reaparezca en un entorno distinto es la señal de que 365 días no es
  una decisión sino el valor que queda cuando nadie lo toca. Se añade su huella reconocible en el
  plan cache —consultas con base nula sobre `internal_table_name` y `sys.syscommittab`, que no
  tienen dueño aparente y por eso se pierden en cualquier informe ordenado por base— y la consulta
  de `sys.change_tracking_databases`.
- **R-14** (funciones escalares en un `SELECT`): el sub-caso de **cómo se lee en el plan cache**.
  La UDF aparece **dos veces**, y la segunda es la reveladora: la consulta padre con **1
  ejecución**, 144.692 ms de CPU y 131.460.437 lecturas, y el cuerpo de la función con **67.736
  ejecuciones** y 128.092.455 lecturas. No son costes que se sumen: es el mismo trabajo visto
  desde dentro, y una sola ejecución del padre se abrió en 67.736 llamadas en unos tres minutos.
  Corolario de detección: una fila con un número de ejecuciones desproporcionado y un texto que
  parece un fragmento suelto (`SELECT TOP 1 @variable = …`) casi siempre es el cuerpo de una UDF
  escalar; buscar esa variable en `sys.sql_modules` la identifica.

**Lo que se decidió NO promover:**

- Que `RESTORE ... WITH PARTIAL` trabaje por filegroup es una característica documentada del motor,
  no un anti-patrón de T-SQL. No pertenece a este catálogo.
- Los 16,09 GB en 130 índices sin lecturas en 57 días **no se promovieron ni se propuso borrarlos**:
  la medición venía de una instancia de **desarrollo**, y R-23 ya exige validar el uso antes de un
  `DROP`. El matiz que sí quedó anotado en el informe, y que aquí importa: en una copia cuyo
  propósito es reproducir producción, quitar índices cambia los planes y destruye justamente
  aquello para lo que existe la copia. La decisión se toma sobre producción y se replica hacia
  abajo, nunca al revés.

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
