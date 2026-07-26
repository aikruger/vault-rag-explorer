import fs from 'fs';
let content = fs.readFileSync('src/settings/VaultRagExplorerSettingTab.ts', 'utf8');

const search = `	private async startExternalIndex(): Promise<void> {
		if (this.indexProcess) {
			new Notice('Indexer already running');
			console.log('[SettingTab] startExternalIndex skipped: already running');
			return;
		}`;

const replace = `	private async startExternalIndex(): Promise<void> {
		if (this.indexProcess || ((this.plugin as any).isExternalIndexerRunning && (this.plugin as any).isExternalIndexerRunning())) {
			new Notice('Indexer already running');
			console.log('[SettingTab] startExternalIndex skipped: already running');
			return;
		}`;

content = content.replace(search, replace);
fs.writeFileSync('src/settings/VaultRagExplorerSettingTab.ts', content);
