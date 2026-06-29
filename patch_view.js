const fs = require('fs');

const p = 'src/views/VaultRagExplorerView.ts';
let code = fs.readFileSync(p, 'utf8');

const highlightMethod = `
	/** Highlight a specific result item and scroll it into view if needed */
	private highlightResultItem(nodeId: string | null) {
		// Clear all highlights
		for (const el of Array.from(this.resultItemMap.values())) {
			el.removeClass("vre-result-item--selected");
		}
		if (nodeId) {
			const targetEl = this.resultItemMap.get(nodeId);
			if (targetEl) {
				targetEl.addClass("vre-result-item--selected");
				targetEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
			}
		}
	}
`;

if (!code.includes('highlightResultItem(nodeId: string | null)')) {
    code = code.replace(
        /private renderMockResults\(\) \{/,
        highlightMethod + '\n\tprivate renderMockResults() {'
    );
}

fs.writeFileSync(p, code);
