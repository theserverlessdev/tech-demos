UPDATE apps
SET redirect_uris = '["https://melody-auth.tech-demos.theserverless.dev/"]'
WHERE client_id = 'melody-sample';

DELETE FROM apps WHERE client_id = 'melody-docs';
