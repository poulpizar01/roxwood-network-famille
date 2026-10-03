/**
 * @file src/permissions.ts
 * @description Vérification d'accès admin partagée par les modules métier :
 * autorisé si le membre a la permission Discord native `Administrator`, ou
 * s'il possède le rôle configuré via `/config role set admin` (`ADMIN_ROLE_ID`
 * — laissé vide pour ne s'appuyer que sur les permissions Discord natives).
 *
 * Ne pas utiliser pour `/config` lui-même : voir la docstring de
 * src/modules/config.ts pour pourquoi cette commande reste toujours
 * `Administrator`-only, indépendamment de `ADMIN_ROLE_ID`.
 *
 * `hasApiAccess` : accès à l'API REST du site externe (src/api/auth.ts),
 * réservé au rôle configuré via `/config role set membre` (`MEMBER_ROLE_ID`).
 */
import { PermissionFlagsBits, type GuildMember, type APIInteractionGuildMember } from 'discord.js';
import * as configStore from './config-store';

/**
 * Vrai si `member` a la permission Discord native `Administrator`, ou le rôle configuré via `/config role set admin`.
 * @param guildId Guilde de l'interaction — sans elle, impossible de savoir quel `ADMIN_ROLE_ID` regarder (multi-tenant, un rôle par guilde).
 * @param member Membre Discord de l'interaction (ou `null` en DM/hors guilde).
 * @returns `false` si `member` est `null` ou n'a ni la permission ni le rôle.
 */
export function isAdmin(guildId: string, member: GuildMember | APIInteractionGuildMember | null): boolean {
  if (!member) return false;
  const hasAdminPerm = 'permissions' in member && typeof member.permissions !== 'string' &&
    member.permissions.has(PermissionFlagsBits.Administrator);
  const roleId = configStore.get(guildId).ADMIN_ROLE_ID;
  const hasAdminRole = !!roleId && 'roles' in member &&
    (('cache' in member.roles && member.roles.cache.has(roleId)) || (Array.isArray(member.roles) && member.roles.includes(roleId)));
  return !!hasAdminPerm || hasAdminRole;
}

/**
 * Vrai si `member` peut utiliser l'API REST du site externe (tout le back-office web) : il a le rôle configuré via
 * `/config role set membre`, ou il est admin.
 *
 * Être sur le serveur Discord ne suffit jamais : un serveur dont le lien
 * d'invitation est public laisserait sinon n'importe quel arrivant obtenir un
 * token (`/auth/login`) et lire la paie, les stocks et les taxes (téléphone et
 * mot de passe compris), sans passer par la validation du site externe.
 *
 * Tant qu'aucun rôle membre n'est configuré, seuls les admins passent :
 * `/config role set membre` ouvre l'accès à ses porteurs. `/config role list`
 * signale le cas.
 * @param guildId Guilde portée par le token — un rôle membre par guilde (multi-tenant).
 */
export function hasApiAccess(guildId: string, member: GuildMember): boolean {
  const roleId = configStore.get(guildId).MEMBER_ROLE_ID;
  return (!!roleId && member.roles.cache.has(roleId)) || isAdmin(guildId, member);
}
