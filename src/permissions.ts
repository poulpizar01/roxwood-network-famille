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
 */
import { PermissionFlagsBits, type GuildMember, type APIInteractionGuildMember } from 'discord.js';
import * as configStore from './config-store';

/**
 * Vrai si `member` a la permission Discord native `Administrator`, ou le rôle configuré via `/config role set admin`.
 * @param member Membre Discord de l'interaction (ou `null` en DM/hors guilde).
 * @returns `false` si `member` est `null` ou n'a ni la permission ni le rôle.
 */
export function isAdmin(member: GuildMember | APIInteractionGuildMember | null): boolean {
  if (!member) return false;
  const hasAdminPerm = 'permissions' in member && typeof member.permissions !== 'string' &&
    member.permissions.has(PermissionFlagsBits.Administrator);
  const roleId = configStore.get().ADMIN_ROLE_ID;
  const hasAdminRole = !!roleId && 'roles' in member &&
    (('cache' in member.roles && member.roles.cache.has(roleId)) || (Array.isArray(member.roles) && member.roles.includes(roleId)));
  return !!hasAdminPerm || hasAdminRole;
}
