# Voti

Voti is a small mobile multiplayer app for game nights. Players anonymously eliminate games until only two remain. Everyone then votes in a final round: the majority wins, and ties are decided randomly.

## Features

- Join rooms using a six-character code or shared link
- Anonymous voting without accounts
- Authoritative host state
- Notification sounds for your turn and other votes
- Final majority vote
- Mobile-first interface
- GitHub Pages deployment

Communication runs directly in the browser using MQTT over WebSockets. No dedicated application server is required.

## Local development

Requirements: Node.js and pnpm.

```bash
pnpm install
pnpm dev
```

The app is available at `http://localhost:5173/voti/`.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## GitHub Pages

The `.github/workflows/deploy-pages.yml` workflow builds and deploys the app automatically on every push to `main`.

In the GitHub repository, select **GitHub Actions** as the source under **Settings → Pages → Build and deployment**.

The app is configured for the `/voti/` project page path.
