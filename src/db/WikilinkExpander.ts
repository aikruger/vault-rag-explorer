import type { Database } from "./Database";

const LOG_PREFIX = "[WikilinkExpander]";

export class WikilinkExpander {
  constructor(private db: Database) {}

  expandFrom(sourcePath: string): { path: string; direction: 'outbound' | 'inbound' }[] {
    console.log(`${LOG_PREFIX} Expanding wikilinks for path=${sourcePath}`);
    const rawDb = this.db.getDb();

    const outboundStmt = rawDb.prepare(`
      SELECT w.dst_path AS path, 'outbound' AS direction
      FROM wikilinks w
      JOIN sources s ON s.id = w.src_source_id
      WHERE s.path = $path AND COALESCE(s.is_deleted, 0) = 0
    `);

    outboundStmt.bind({ $path: sourcePath });
    const outbound: { path: string; direction: string }[] = [];
    while (outboundStmt.step()) {
       outbound.push(outboundStmt.getAsObject() as { path: string; direction: string });
    }
    outboundStmt.free();

    const inboundStmt = rawDb.prepare(`
      SELECT s.path, 'inbound' AS direction
      FROM wikilinks w
      JOIN sources s ON s.id = w.src_source_id
      WHERE w.dst_path = $path AND COALESCE(s.is_deleted, 0) = 0
    `);

    inboundStmt.bind({ $path: sourcePath });
    const inbound: { path: string; direction: string }[] = [];
    while (inboundStmt.step()) {
       inbound.push(inboundStmt.getAsObject() as { path: string; direction: string });
    }
    inboundStmt.free();

    const all = [...outbound, ...inbound];
    console.log(`${LOG_PREFIX} Found ${all.length} wikilink neighbours for ${sourcePath}`);
    return all as { path: string; direction: 'outbound' | 'inbound' }[];
  }
}
