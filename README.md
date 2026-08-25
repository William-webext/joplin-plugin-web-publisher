<div align="center">

# 🌐 Joplin Web Publisher

**Publish your Joplin notebooks to the web, straight from Joplin Desktop.**
A companion plugin for [Joplin Web Portal](https://github.com/william-webext/joplin-web) — the self-hosted, read-only web viewer for your notes.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/joplin-plugin-web-publisher)](https://www.npmjs.com/package/joplin-plugin-web-publisher)
![Joplin Plugin](https://img.shields.io/badge/Joplin-plugin-1071d3)

</div>

---

## What it does

Right-click any notebook in Joplin Desktop → **Publish / Update / Remove from Web** — choose who can see it, and it's live on your own web portal. No manual server steps, no database edits.

- 🌍 **Public** — visible to anyone with the link, no login required
- 🔒 **Registered users** — visible to anyone logged in to your web portal
- 🎯 **Custom access** — restricted to specific people or groups you pick from a list
- 🗑️ **Unpublish** — pull a notebook (and its sub-notebooks) off the web at any time
- 📋 A side panel in Joplin lists everything currently published, with quick edit/unpublish actions

Publishing a notebook automatically includes all of its sub-notebooks.

## Requirements

This plugin is the "publish" half of a pair — it needs a running instance of **[Joplin Web Portal](https://github.com/william-webext/joplin-web)** to publish to. It won't do anything useful on its own.

## Installation

Search **"Web Publisher"** directly from **Joplin → Options → Plugins**, or install it from its listing pages:

- 🧩 [Joplin plugin listing](https://joplinapp.org/plugins/plugin/com.william.webppublisher/)
- 📥 [npm package](https://www.npmjs.com/package/joplin-plugin-web-publisher)

Prefer installing manually?
1. Download the `.jpl` file from [Releases](../../releases)
2. In Joplin: **Options → Plugins → Install from file** → select the `.jpl`

## Setup

**Joplin → Options → Web Publisher**, fill in:

| Setting | What it is |
|---|---|
| **Web Server URL** | The address of your Joplin Web Portal instance, e.g. `https://notes.example.com` |
| **Account Email** | Your login on that web portal |
| **Account Password** | Stored using Joplin's encrypted settings storage — never written in plain text |

## How it works

The plugin talks directly to your web portal's API: it logs in with your account, reads the notebook you're publishing (including all sub-notebooks and notes), and sends it over. The web portal decides how to store and serve it based on the visibility level you picked. Nothing touches the Joplin Server database directly — it all goes through the portal's own API.

## Security notes

- Your password is stored via Joplin's own secure settings storage (encrypted at rest), never in plain text
- Session tokens are cached in memory only, never written to disk, and expire automatically
- All content shown in dialogs and panels (folder titles, user lists, server responses) is sanitized before rendering — a malicious or misbehaving server can't inject code into the plugin's UI

## Support / feedback

Something broken, or a feature you'd like to see? Write to **joplin [at] rossodivino [dot] com** — happy to hear about bugs, ideas, or just what you're using this for.

## Support the project

This project is free, open source, and maintained in spare time. If it's useful to you, consider [buying me a coffee on PayPal](https://paypal.me/webext) — every bit helps keep it going.

## License

Licensed under the **[GNU Affero General Public License v3.0](./LICENSE)**. In short: you're free to use, modify, and redistribute this software. If you modify it and offer it as a service to others, you must make your modified source available too, under the same license.