-- L'accès « taxes » n'existe plus (les taxes passent par le rôle membre, comme le reste de l'API) : ses associations de rôle sont retirées.
DELETE FROM "discord_roles" WHERE "target" = 'taxes';
