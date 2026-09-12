-- `coffre_admin` (salon unique) devient `logs_coffres_admin` (liste, meme
-- principe que `logs_coffres`) : une guilde peut avoir plusieurs coffres
-- admin. Migration de donnees pure, `channels.role` est une simple colonne
-- texte sans contrainte — aucun changement de schema necessaire.
UPDATE "channels" SET role = 'logs_coffres_admin' WHERE role = 'coffre_admin';
