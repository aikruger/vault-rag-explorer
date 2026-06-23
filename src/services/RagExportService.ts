import type { Database } from "../db/Database";
import type { LockedNode } from "./LockedNodesService";

const LOG_PREFIX = "[RagExportService]";

export class RagExportService {
  constructor(private db: Database) {}

  async buildContextBundle(lockedNodes: LockedNode[]): Promise<string> {
    const rawDb = this.db.getDb();
    const selectSource = rawDb.prepare(`SELECT title, metadata_json FROM sources WHERE id = $id`);
    const selectBlock = rawDb.prepare(`SELECT block_label, text, block_path FROM blocks WHERE id = $id`);

    const sections: string[] = [];

    for (const node of lockedNodes) {
      if (node.nodeType === "note") {
        selectSource.bind({ $id: node.nodeId });
        if (selectSource.step()) {
          const row = selectSource.getAsObject() as { title: string; metadata_json: string };
          sections.push(
            `### Source: ${row.title}\n` +
            `**Path**: ${node.path}\n` +
            `**Type**: Note\n\n` +
            `Metadata: ${row.metadata_json}`
          );
        }
        selectSource.reset();
      } else if (node.nodeType === "block") {
        selectBlock.bind({ $id: node.nodeId });
        if (selectBlock.step()) {
          const row = selectBlock.getAsObject() as { block_label: string; text: string; block_path: string };
          sections.push(
            `### Block: ${row.block_label}\n` +
            `**Path**: ${row.block_path}\n` +
            `**Key**: ${node.blockKey}\n` +
            `**Type**: Block\n\n` +
            `${row.text}`
          );
        }
        selectBlock.reset();
      }
    }

    selectSource.free();
    selectBlock.free();

    const bundle = sections.join("\n\n---\n\n");
    const header = `RAG Context Bundle\nNodes: ${lockedNodes.length}\nCharacters: ${bundle.length}\n\n`;
    const finalString = header + bundle;

    console.log(`${LOG_PREFIX} Built context bundle nodeCount=${lockedNodes.length} chars=${finalString.length}`);
    return finalString;
  }
}
