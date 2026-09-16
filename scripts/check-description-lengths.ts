/**
 * @file scripts/check-description-lengths.ts
 * @description Outil de non-régression : scanne `src/` pour tout
 * `.setDescription(...)` de commande/option slash (jamais un `EmbedBuilder`,
 * qui n'a pas de `.setName()`) et signale tout dépassement de la limite
 * Discord de 100 caractères. Un dépassement bloque silencieusement le
 * déploiement de TOUTES les commandes slash pour la guilde concernée (juste
 * une erreur dans les logs) — à relancer après chaque ajout d'option.
 *
 * Heuristique : dans ce projet, `.setDescription(` d'une commande/sous-
 * commande/option suit toujours immédiatement `.setName(...)` sur le même
 * objet (`SlashCommandBuilder`/`SlashCommandSubcommandBuilder`/options) — un
 * `EmbedBuilder` n'a pas de `.setName()`, donc ce pattern ne matche jamais un
 * embed. Ne gère que les littéraux simples (`'...'`/`"..."`), pas les
 * template literals avec expression — une description dynamique n'a de toute
 * façon pas de longueur fixe à vérifier statiquement.
 *
 * Lancer : `npx tsx scripts/check-description-lengths.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_DIR = join(__dirname, '..', 'src');
const LIMIT = 100;

const NAME_THEN_DESCRIPTION = /\.setName\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)\s*\.setDescription\(\s*(['"])((?:\\.|(?!\3).)*)\3\s*\)/gs;

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(['"\\])/g, '$1');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  name: string;
  length: number;
  description: string;
}

const violations: Violation[] = [];
let checked = 0;

for (const file of listTsFiles(SRC_DIR)) {
  const content = readFileSync(file, 'utf-8');
  NAME_THEN_DESCRIPTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAME_THEN_DESCRIPTION.exec(content))) {
    checked++;
    const name = unescapeLiteral(match[2]);
    const description = unescapeLiteral(match[4]);
    if (description.length > LIMIT) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push({ file: relative(join(__dirname, '..'), file), line, name, length: description.length, description });
    }
  }
}

console.log(`[check-description-lengths] ${checked} description(s) de commande/option vérifiée(s).`);

if (violations.length) {
  console.error(`\n❌ ${violations.length} description(s) dépassent ${LIMIT} caractères :\n`);
  for (const v of violations) {
    console.error(`${v.file}:${v.line} — "${v.name}" (${v.length} caractères)\n  ${v.description}\n`);
  }
  process.exit(1);
}

console.log('✅ Toutes les descriptions respectent la limite Discord.');
