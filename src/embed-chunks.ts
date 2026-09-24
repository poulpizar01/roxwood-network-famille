/**
 * @file src/embed-chunks.ts
 * @description Découpe une liste de lignes potentiellement longue en
 * plusieurs embeds Discord, pour un affichage arme par arme / joueur par
 * joueur / etc. qui peut grossir sans borne avec le temps (inventaire,
 * classement, historique...).
 *
 * Deux limites à respecter, pas une seule :
 * - 4096 caractères par description d'embed (documenté par Discord,
 *   {@link DEFAULT_CHAR_BUDGET} garde une marge en dessous).
 * - Un nombre de LIGNES avant troncature silencieuse côté client — constaté
 *   empiriquement (un embed de 2487 caractères / 83 lignes tronqué à
 *   l'affichage sur desktop/web/mobile alors que `interaction.fetchReply()`
 *   confirmait la description complète bien stockée côté API), jamais
 *   documenté officiellement par Discord. {@link DEFAULT_MAX_LINES} reste
 *   prudemment en dessous du point de rupture observé (~81).
 *
 * Un décompte en caractères seul (`if (length + line.length > 3900)`) ne
 * protège PAS contre le second cas : beaucoup de lignes courtes peuvent
 * rester sous 4096 caractères tout en dépassant le seuil de rendu. D'où ce
 * module : le découpage se fait sur le PREMIER budget dépassé, caractères
 * OU lignes.
 */
import { EmbedBuilder } from 'discord.js';

/** Marge sous la limite Discord de 4096 caractères par description d'embed. */
const DEFAULT_CHAR_BUDGET = 3900;

/**
 * Marge sous le point de rupture de rendu observé empiriquement (~81 lignes)
 * — aucun seuil précis n'est documenté par Discord, cette valeur reste
 * volontairement prudente plutôt que de coller au plus près du point
 * observé sur un seul cas.
 */
const DEFAULT_MAX_LINES = 70;

/** Limite dure Discord : au plus 10 embeds par message. */
const DEFAULT_MAX_EMBEDS = 10;

/**
 * Un groupe de lignes affichées ensemble, avec un en-tête optionnel
 * (ex. `__Armes de poing__`) réinjecté en haut de CHAQUE nouvel embed si la
 * coupure tombe au milieu du groupe — pour qu'un groupement reste lisible
 * même à cheval sur plusieurs embeds. Une liste plate (pas de groupement,
 * ex. un classement) passe une seule section sans `header`.
 */
export interface EmbedChunkSection {
  header?: string;
  lines: string[];
}

export interface ChunkEmbedsOptions {
  /** Titre affiché uniquement sur le premier embed. */
  title?: string;
  color?: number;
  /** Description utilisée pour un unique embed vide si `sections` ne contient aucune ligne. */
  emptyDescription?: string;
  /** Appelée pour chaque embed (index, total) ; une valeur non nulle devient son footer. */
  footer?: (index: number, total: number) => string | null;
  charBudget?: number;
  maxLines?: number;
  maxEmbeds?: number;
}

/**
 * Construit une liste d'`EmbedBuilder` à partir de sections de lignes, en
 * respectant à la fois un budget de caractères et un budget de lignes par
 * embed (voir docstring de fichier). Au-delà de `maxEmbeds` (défaut 10, la
 * limite Discord), tronque et ajoute une note "+N non affichées" sur le
 * dernier embed plutôt que de laisser l'envoi échouer.
 */
export function buildChunkedEmbeds(sections: EmbedChunkSection[], options: ChunkEmbedsOptions = {}): EmbedBuilder[] {
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxEmbeds = options.maxEmbeds ?? DEFAULT_MAX_EMBEDS;

  const totalContentLines = sections.reduce((sum, s) => sum + s.lines.length, 0);

  const applyMeta = (embed: EmbedBuilder, index: number, total: number): EmbedBuilder => {
    if (index === 0 && options.title) embed.setTitle(options.title);
    if (options.color !== undefined) embed.setColor(options.color);
    const footerText = options.footer?.(index, total);
    if (footerText) embed.setFooter({ text: footerText });
    return embed;
  };

  if (!totalContentLines) {
    const embed = new EmbedBuilder().setDescription(options.emptyDescription ?? '*Aucune donnée*');
    return [applyMeta(embed, 0, 1)];
  }

  const chunks: string[][] = [];
  const chunkContentCounts: number[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let currentContentCount = 0;

  const flush = () => {
    if (current.length) {
      chunks.push(current);
      chunkContentCounts.push(currentContentCount);
    }
    current = [];
    currentChars = 0;
    currentContentCount = 0;
  };

  for (const section of sections) {
    let pendingHeader = section.header ?? null;
    for (const line of section.lines) {
      const headerExtra = pendingHeader ? pendingHeader.length + 1 : 0;
      const extraLines = pendingHeader ? 2 : 1;
      const wouldOverflow = current.length > 0
        && (currentChars + headerExtra + line.length + 1 > charBudget || current.length + extraLines > maxLines);
      if (wouldOverflow) {
        flush();
        // La coupure tombe au milieu de cette section : réinjecte l'en-tête
        // en haut du nouvel embed pour ne pas perdre le contexte.
        pendingHeader = section.header ?? null;
      }
      if (pendingHeader) {
        current.push(pendingHeader);
        currentChars += pendingHeader.length + 1;
        pendingHeader = null;
      }
      current.push(line);
      currentChars += line.length + 1;
      currentContentCount++;
    }
  }
  flush();

  let truncatedNotice: string | null = null;
  if (chunks.length > maxEmbeds) {
    const kept = chunkContentCounts.slice(0, maxEmbeds - 1);
    const shown = kept.reduce((a, b) => a + b, 0);
    const remaining = totalContentLines - shown;
    chunks.length = maxEmbeds - 1;
    truncatedNotice = `*+${remaining} entrée(s) supplémentaire(s) non affichée(s) — la liste est trop longue pour un seul message.*`;
  }

  return chunks.map((chunkLines, i) => {
    const embed = new EmbedBuilder();
    const desc = truncatedNotice && i === chunks.length - 1
      ? `${chunkLines.join('\n')}\n\n${truncatedNotice}`
      : chunkLines.join('\n');
    embed.setDescription(desc);
    return applyMeta(embed, i, chunks.length);
  });
}
