# Obsidian Sample Plugin

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.

- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open modal (simple)" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and outputs a Notice on click.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `src/main.ts` to `main.js`.
- Make changes to `src/main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## Configuration

Vault RAG Explorer now includes a plugin settings tab.

Open:

**Settings → Community plugins → Vault RAG Explorer**

Then set:

- **Smart folder** — the path to the folder containing Smart Connections exports, derived SQLite data, or related smart data files used by this plugin.

If the Smart folder is not configured, query execution is blocked and the plugin will prompt you to set it first.

## Functionality

Vault RAG Explorer provides an interactive retrieval workspace inside Obsidian for exploring indexed vault content.

### Main operations

- Run a semantic query from the Query panel.
- Review ranked note and block hits in the Results panel.
- Inspect a selected hit in the Inspector panel.
- Lock or unlock relevant nodes for later export.
- Save the current session, including graph positions.
- Reload the most recent saved session.
- Export locked nodes as a Markdown RAG context bundle into the vault.
- Expand from a selected item using semantic neighbours.
- Expand from a selected item using wikilink relationships.
- Explore the current result set visually in the Cytoscape graph.

### Interface

The explorer is divided into four coordinated panels:

- **Query panel** — query input and workflow actions such as Run Query, Lock All Visible, Save Session, Load Session, and Export RAG Context.
- **Results panel** — ranked retrieval hits with actions to inspect, lock, and open the source file.
- **Graph panel** — Cytoscape-based graph of hits and wikilink relationships.
- **Inspector panel** — detailed information for the selected hit, including lock, semantic expansion, and wikilink expansion actions.

## Current workflow

1. Open **Vault RAG Explorer** from the ribbon icon or command palette.
2. Open plugin settings and configure the **Smart folder**.
3. Enter a query in the Query panel.
4. Review ranked hits in the Results panel.
5. Inspect and lock relevant notes or blocks.
6. Expand selected nodes semantically or by wikilinks.
7. Save the session or export locked context as Markdown.

## Current limitations

This milestone provides the core explorer workflow, but configuration and data-source validation are still lightweight.

Known limitations include:

- The Smart folder setting is currently a plain path field and does not yet browse the vault interactively.
- Validation currently confirms presence of a configured path, but deeper verification of expected files may still need to be added.
- Some services may still rely on milestone scaffolding while the data-loading pipeline is being completed.

## Improve code quality with eslint

- [ESLint](https://eslint.org/) is a tool that analyzes your code to quickly find problems. You can run ESLint against your plugin to find common bugs and ways to improve your code.
- This project already has eslint preconfigured, you can invoke a check by running`npm run lint`
- Together with a custom eslint [plugin](https://github.com/obsidianmd/eslint-plugin) for Obsidan specific code guidelines.
- A GitHub action is preconfigured to automatically lint every commit on all branches.

## Funding URL

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
	"fundingUrl": "https://buymeacoffee.com"
}
```

If you have multiple URLs, you can also do:

```json
{
	"fundingUrl": {
		"Buy Me a Coffee": "https://buymeacoffee.com",
		"GitHub Sponsor": "https://github.com/sponsors",
		"Patreon": "https://www.patreon.com/"
	}
}
```

## API Documentation

See https://docs.obsidian.md
