# Repository architecture

Run development and release commands from the repository root. `package.json` and `package-lock.json` own development dependencies and commands; `app/package.json` contains only the installed Electron runtime metadata. Release verification checks that their name and version agree.

| Directory | Responsibility |
| --- | --- |
| `app/` | Shared browser UI, Electron entry/preload, local Python service, domain logic, styles and runtime resources |
| `scripts/` | Development launch, native packaging, isolated backend test runner, portable release and demo tooling |
| `tests/` | Domain, transport, UI, persistence and packaging regressions, with synthetic fixtures |
| `cloud/` | Container and SSH deployment configuration for `app/cloud_server.py` |
| `docs/` | User, contributor-facing architecture, distribution and brand guides |
| `demo/` | Fictional data used by product recordings |
| `launch/` | Independently deployed static product site with Chinese and English media |

## Runtime and source layout

`app/asset-manifest.json` is the shared resource allowlist for the HTTP server and desktop packages. App-relative URLs and module imports are preserved inside `app/`. Build and test tools are excluded from the installed application unless explicitly required by the runtime contract. Python runtime files remain unavailable over HTTP.

The repository layout does not move user workspaces, attachments, credentials or sync data. Installed packages continue to use `Contents/Resources/app/`, and builds preserve the existing application identifier. Release tooling stages an isolated runtime copy, checks source identity and verifies the finished bundle before creating an archive.

The root npm commands remain stable: `npm start`, `npm test`, `npm run app`, and `npm run release:mac -- --output NEW_DIRECTORY`.
