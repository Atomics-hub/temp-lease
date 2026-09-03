# Contributing

Thanks for helping make `temp-lease` safer.

## Development

```bash
npm install
npm run verify
```

Node.js 20 or newer is required. Filesystem behavior differs across operating systems, so lifecycle changes should include Linux, macOS, and Windows coverage where relevant.

## Pull requests

- Add a regression test before changing recovery behavior.
- Preserve fail-closed handling for unknown liveness, namespaces, permissions, and filesystem identities.
- Do not broaden recovery beyond package-owned direct children.
- Document new behavior and user-visible receipt fields.
- Keep the runtime dependency count at zero unless a dependency is essential and separately justified.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
