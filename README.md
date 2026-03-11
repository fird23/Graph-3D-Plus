# Graph 3D Plus

3D graph view for Obsidian with tags, attachments, hover highlighting, and an in-graph settings panel.

## Features
- 3D force-directed layout with sphere distribution
- Tags as red nodes, attachments as green nodes
- Hover highlighting and labels
- Drag nodes and open files on click
- In-graph settings overlay with filters and search

## Installation (Manual)
1. Copy the release files (`main.js`, `manifest.json`, `styles.css`) into:
   `.obsidian/plugins/graph-3d-plus/`
2. Enable the plugin in Obsidian.

## Development
```bash
npm install
npm run dev
```

Build release:
```bash
npm run build
```

## Release
Attach `main.js`, `manifest.json`, `styles.css` to a GitHub Release.
