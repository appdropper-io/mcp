# Releasing @appdropper/mcp

## First release (once)

Done on 2026-10-01 (0.1.0). What remains:

1. On npmjs.com → @appdropper/mcp → Settings → Trusted publishing, add
   organization `appdropper-io`, repository `mcp`, workflow `publish.yml`.

## Every release after that

1. Bump `version` in package.json (semver; still 0.x while the tool surface
   settles).
2. Commit, then `git tag vX.Y.Z && git push --tags`. `publish.yml` tests,
   smoke-tests the packed tarball, and publishes (trusted publishing attaches provenance).
