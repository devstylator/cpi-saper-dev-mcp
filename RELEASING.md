# Releasing

How a version of `cpi-saper-dev-mcp` gets to npm and GitHub. Steps marked **(maintainer)** need the maintainer's npm
and GitHub accounts; the rest is prepared in a commit.

## Prepared in the release commit

1. The version in `packages/mcp-server/src/version.ts`, `packages/mcp-server/package.json` and
   `packages/core/package.json` (a test keeps the server's reported version equal to the package's).
2. A `CHANGELOG.md` section for the version, with its date.
3. `npm test` and `npm run pack:check` pass (the second installs the packed package into an empty folder and starts it).

## Publishing (maintainer)

1. Push the release commit and wait for CI to pass (it runs the tests and the package check):
   `git push`
2. Log in to npm once per machine: `npm login`
3. Publish from the package folder, as a beta while the version is a pre-release:
   ```sh
   npm run pack:check
   cd packages/mcp-server
   npm publish --tag beta
   ```
   `npm publish` builds the bundle itself (prepack). With two-factor authentication npm asks for a code.
4. While there is no stable 1.0, let the plain name point to the newest beta too:
   `npm dist-tag add cpi-saper-dev-mcp@<version> latest`
5. Tag the release commit and push the tag:
   `git tag v<version> && git push origin v<version>`
6. On GitHub: **Releases → Create a new release**, choose the tag `v<version>`, title `<version>`, paste the version's
   CHANGELOG section as description, tick **Set as a pre-release** (for betas), **Publish release**.
7. Check it as a user would, in an empty folder: `npx -y cpi-saper-dev-mcp@beta textconv <some .iflw>` and
   `npm view cpi-saper-dev-mcp dist-tags`.

A published version cannot be changed: a mistake is fixed with the next version (unpublishing is possible only
within 72 hours, and the number cannot be reused).
