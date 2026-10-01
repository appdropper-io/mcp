# Releasing @appdropper/mcp

## First release (once)

1. `appdropper@1.2.0` must be on npm first — this package depends on its
   `appdropper/api` entry point. Release it from the `appdropper-cli` repo.
2. Create the npm organization `appdropper` (free for public packages) and
   make sure your npm user can publish to it.
3. Regenerate the lockfile against the registry (development used a local
   CLI tarball): `rm -rf node_modules package-lock.json && npm install`.
4. `npm run check`, then `npm publish` from your own terminal (npm asks for
   your passkey). `publishConfig` already sets public access.
5. On npmjs.com → @appdropper/mcp → Settings → Trusted publishing, add
   organization `appdropper-io`, repository `mcp`, workflow `publish.yml`.

## Every release after that

1. Bump `version` in package.json (semver; still 0.x while the tool surface
   settles).
2. Commit, then `git tag vX.Y.Z && git push --tags`. `publish.yml` tests,
   smoke-tests the packed tarball, and publishes (trusted publishing attaches provenance).
