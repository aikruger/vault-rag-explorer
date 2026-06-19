import type { Database } from "../db/Database";
import type { LockedNode } from "./LockedNodesService";

const LOG_PREFIX = "[RagExportService]";

export class RagExportService {
  constructor(private db: Database) {}

  async buildContextBundle(lockedNodes: LockedNode[]): Promise<string> {
    const rawDb = this.db.getDb();
    const selectSource = rawDb.prepare(`SELECT title, metadata_json FROM sources WHERE id = ?`);
    const selectBlock = rawDb.prepare(`SELECT block_label, text, block_path FROM blocks WHERE id = ?`);

    const sections: string[] = [];

    for (const node of lockedNodes) {
      if (node.nodeType === "note") { // Changed from 'source' to match the updated LockedNode interface
        const row = selectSource.get(node.nodeId) as { title: string, metadata_json: string } | undefined;
        if (row) {
          sections.push(
            `### Source: ${row.title}\n` +
            `**Path**: ${node.path}\n` +
            `**Type**: Note\n\n` +
            `Metadata: ${row.metadata_json}`
          );
        }
      } else if (node.nodeType === "block") {
        const row = selectBlock.get(node.nodeId) as { block_label: string, text: string, block_path: string } | undefined;
        if (row) {
          sections.push(
            `### Block: ${row.block_label}\n` +
            `**Path**: ${row.block_path}\n` +
            `**Key**: ${node.blockKey}\n` +
            `**Type**: Block\n\n` +
            `${row.text}`
          );
        }
      }
    }

    const bundle = sections.join("\n\n---\n\n");
    const header = `RAG Context Bundle\nNodes: ${lockedNodes.length}\nCharacters: ${bundle.length}\n\n`;
    const finalString = header + bundle;

    console.log(`${LOG_PREFIX} Built context bundle nodeCount=${lockedNodes.length} chars=${finalString.length}`);
    return finalString;
  }
}
