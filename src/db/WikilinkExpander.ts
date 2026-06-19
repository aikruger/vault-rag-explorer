import type { Database } from "./Database";

const LOG_PREFIX = "[WikilinkExpander]";

export class WikilinkExpander {
  constructor(private db: Database) {}

  expandFrom(sourcePath: string): { path: string; direction: 'outbound' | 'inbound' }[] {
    console.log(`${LOG_PREFIX} Expanding wikilinks for path=${sourcePath}`);
    const rawDb = this.db.getDb();

    const outbound = rawDb.prepare(`
      SELECT w.dst_path AS path, 'outbound' AS direction
      FROM wikilinks w
      JOIN sources s ON s.id = w.src_source_id
      WHERE s.path = ?
    `).all(sourcePath) as { path: string; direction: string }[];

    const inbound = rawDb.prepare(`
      SELECT s.path, 'inbound' AS direction
      FROM wikilinks w
      JOIN sources s ON s.id = w.src_source_id
      WHERE w.dst_path = ?
    `).all(sourcePath) as { path: string; direction: string }[];

    const all = [...outbound, ...inbound];
    console.log(`${LOG_PREFIX} Found ${all.length} wikilink neighbours for ${sourcePath}`);
    return all as { path: string; direction: 'outbound' | 'inbound' }[];
  }
}
