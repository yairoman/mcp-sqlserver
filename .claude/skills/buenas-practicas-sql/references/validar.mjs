#!/usr/bin/env node
/**
 * Validacion de consistencia de los skills de base de datos.
 *
 * Paso obligatorio del protocolo de actualizacion, antes de cerrar una
 * version del catalogo:
 *
 *     npm run validate:skills
 *     (o directamente: node .claude/skills/buenas-practicas-sql/references/validar.mjs)
 *
 * Sale con codigo 0 si todo es consistente; 1 si hay fallos, listandolos.
 * Solo usa modulos nativos de Node: sin dependencias.
 *
 * Comprueba:
 *   1. Frontmatter de cada SKILL.md. Un ': ' sin comillas dentro de
 *      `description` es YAML invalido: el harness deja de leer la descripcion
 *      y el skill DEJA DE ACTIVARSE solo (fallo real ocurrido en este repo).
 *   2. Enlaces markdown: todo [texto](ruta) relativo debe resolver a un archivo.
 *   3. Citas R-xx: toda cita en indice, checklist y registro apunta a una regla
 *      definida en reglas.md, y ninguna regla queda huerfana (definida pero
 *      jamas citada fuera de reglas.md).
 *   4. El encabezado "N reglas" del SKILL.md y las filas R-xx de su indice
 *      cuadran exactamente con las reglas definidas.
 *   5. Rutas citadas como texto plano entre skills.
 *
 * NO comprueba anonimizacion: los nombres a detectar no pueden escribirse
 * aqui, porque este archivo se versiona y los filtraria. Ese escaneo sigue
 * siendo manual; la politica esta en SKILL.md.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// references/ -> buenas-practicas-sql -> skills -> .claude -> raiz del repo
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..", "..", "..");
const SKILLS = path.join(RAIZ, ".claude", "skills");
const REGLAS = path.join(SKILLS, "buenas-practicas-sql", "references", "reglas.md");
const SKILL_BP = path.join(SKILLS, "buenas-practicas-sql", "SKILL.md");

const fallos = [];
const leer = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p) => path.relative(RAIZ, p);
const porNumero = (a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10);

function* archivosMd(dir) {
  for (const entrada of readdirSync(dir)) {
    const ruta = path.join(dir, entrada);
    if (statSync(ruta).isDirectory()) yield* archivosMd(ruta);
    else if (ruta.endsWith(".md")) yield ruta;
  }
}

// --- 1) Frontmatter de cada SKILL.md ----------------------------------------
function validarFrontmatter() {
  for (const entrada of readdirSync(SKILLS)) {
    const ruta = path.join(SKILLS, entrada, "SKILL.md");
    if (!existsSync(ruta)) continue;
    const m = leer(ruta).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!m) {
      fallos.push(`SIN FRONTMATTER: ${rel(ruta)}`);
      continue;
    }
    const claves = {};
    for (const linea of m[1].split("\n")) {
      if (!linea.trim()) continue;
      const kv = linea.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!kv) {
        // El frontmatter de estos skills es clave: valor en una linea; otra
        // cosa (escalares plegados, listas) no la valida este script.
        fallos.push(`FRONTMATTER NO SOPORTADO en ${rel(ruta)}: "${linea.slice(0, 60)}"`);
        continue;
      }
      const [, clave, valor] = kv;
      claves[clave] = valor;
      // El fallo real: un ': ' dentro de un valor sin comillas es YAML
      // invalido y el harness descarta la descripcion en silencio.
      const sinComillas = !/^["']/.test(valor);
      if (sinComillas && valor.includes(": ")) {
        fallos.push(
          `YAML INVALIDO en ${rel(ruta)}: ': ' dentro del valor de "${clave}" — ` +
            `usa raya o punto y coma, o entrecomilla el valor`
        );
      }
    }
    for (const requerida of ["name", "description"]) {
      if (!claves[requerida]) fallos.push(`FRONTMATTER SIN "${requerida}": ${rel(ruta)}`);
    }
  }
}

// --- 2) Enlaces markdown -----------------------------------------------------
function validarEnlaces() {
  const archivos = [...archivosMd(SKILLS)];
  const claudeMd = path.join(RAIZ, "CLAUDE.md");
  if (existsSync(claudeMd)) archivos.push(claudeMd);

  let n = 0;
  for (const f of archivos) {
    for (const m of leer(f).matchAll(/\[[^\]]*\]\(([^)#\s]+)\)/g)) {
      const destino = m[1];
      if (/^(https?:|mailto:)/.test(destino)) continue;
      n++;
      const resuelto = path.resolve(path.dirname(f), destino);
      if (!existsSync(resuelto)) fallos.push(`ENLACE ROTO en ${rel(f)}: ${destino}`);
    }
  }
  return n;
}

// --- 3) Citas R-xx vs reglas definidas --------------------------------------
function validarReglas() {
  const definidas = new Set([...leer(REGLAS).matchAll(/^## (R-\d+)/gm)].map((m) => m[1]));
  const citadas = new Map(); // regla -> [archivos]
  const citadasFuera = new Set();

  for (const f of archivosMd(SKILLS)) {
    const menciones = new Set([...leer(f).matchAll(/\bR-\d+\b/g)].map((m) => m[0]));
    for (const r of menciones) {
      if (!citadas.has(r)) citadas.set(r, []);
      citadas.get(r).push(rel(f));
      if (path.resolve(f) !== path.resolve(REGLAS)) citadasFuera.add(r);
    }
  }

  for (const r of [...citadas.keys()].filter((r) => !definidas.has(r)).sort(porNumero)) {
    fallos.push(`CITA A REGLA INEXISTENTE ${r} en ${citadas.get(r).join(", ")}`);
  }
  for (const r of [...definidas].filter((r) => !citadasFuera.has(r)).sort(porNumero)) {
    fallos.push(`REGLA HUERFANA ${r}: definida pero no citada en indice/checklist/registro`);
  }
  return definidas;
}

// --- 4) Encabezado e indice del SKILL ---------------------------------------
function validarIndice(definidas) {
  const s = leer(SKILL_BP);
  const m = s.match(/\*\*(\d+) reglas en 4 niveles/);
  if (!m) {
    fallos.push(`SKILL.md: no se encontro el encabezado "**N reglas en 4 niveles**"`);
  } else if (parseInt(m[1], 10) !== definidas.size) {
    fallos.push(`ENCABEZADO DICE ${m[1]} REGLAS; reglas.md define ${definidas.size}`);
  }
  const indice = new Set([...s.matchAll(/\| \*\*(R-\d+)\*\*/g)].map((x) => x[1]));
  for (const r of [...definidas].filter((r) => !indice.has(r)).sort(porNumero)) {
    fallos.push(`REGLA SIN FILA EN EL INDICE del SKILL: ${r}`);
  }
  for (const r of [...indice].filter((r) => !definidas.has(r)).sort(porNumero)) {
    fallos.push(`EL INDICE DEL SKILL CITA UNA REGLA INEXISTENTE: ${r}`);
  }
}

// --- 5) Rutas citadas como texto plano --------------------------------------
function validarRutasTexto() {
  const casos = [
    [path.join(SKILLS, "analisis-bd", "SKILL.md"), "buenas-practicas-sql/references/reglas.md", REGLAS],
    [path.join(SKILLS, "analisis-bd", "SKILL.md"), "references/registro.md",
      path.join(SKILLS, "buenas-practicas-sql", "references", "registro.md")],
    [REGLAS, "SKILL.md", SKILL_BP],
  ];
  for (const [origen, cita, destino] of casos) {
    if (leer(origen).includes(cita) && !existsSync(destino)) {
      fallos.push(`RUTA TEXTO ROTA: ${rel(origen)} cita ${cita}`);
    }
  }
}

// -----------------------------------------------------------------------------
validarFrontmatter();
const nEnlaces = validarEnlaces();
const definidas = validarReglas();
validarIndice(definidas);
validarRutasTexto();

console.log(`Reglas definidas: ${definidas.size} | Enlaces revisados: ${nEnlaces}`);
if (fallos.length) {
  console.log("\n=== FALLOS ===");
  for (const x of fallos) console.log(" ", x);
  process.exitCode = 1;
} else {
  console.log("=== TODO CONSISTENTE ===");
}
