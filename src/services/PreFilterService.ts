import type { Database } from '../db/Database';

const LOG_PREFIX = '[PreFilterService]';

export interface PreFilterOptions {
  // Inclusion filters — all are ANDed together
  folderIncludes: string[];       // path must start with one of these
  tagIncludes: string[];          // metadata_json must contain all of these tags
  fileNameIncludes: string[];     // title LIKE '%value%' (partial match)
  fileNameExact: string[];        // title = value (exact match)
  createdAfter: number | null;    // mtime >= value (unix ms)
  createdBefore: number | null;   // mtime <= value (unix ms)
  propertyFilters: { key: string; value: string }[]; // metadata_json key=value pairs

  // Exclusion filters — any match removes the source
  folderExcludes: string[];
  tagExcludes: string[];
  fileNameExcludes: string[];     // title LIKE '%value%'
  excludedSourceIds: number[];    // explicit id exclusions (from the exclusion list feature)
}

export const EMPTY_PREFILTER: PreFilterOptions = {
  folderIncludes: [],
  tagIncludes: [],
  fileNameIncludes: [],
  fileNameExact: [],
  createdAfter: null,
  createdBefore: null,
  propertyFilters: [],
  folderExcludes: [],
  tagExcludes: [],
  fileNameExcludes: [],
  excludedSourceIds: [],
};

export function isPreFilterEmpty(opts: PreFilterOptions): boolean {
  return (
    opts.folderIncludes.length === 0 &&
    opts.tagIncludes.length === 0 &&
    opts.fileNameIncludes.length === 0 &&
    opts.fileNameExact.length === 0 &&
    opts.createdAfter === null &&
    opts.createdBefore === null &&
    opts.propertyFilters.length === 0 &&
    opts.folderExcludes.length === 0 &&
    opts.tagExcludes.length === 0 &&
    opts.fileNameExcludes.length === 0 &&
    opts.excludedSourceIds.length === 0
  );
}

export class PreFilterService {
  constructor(private db: Database) {}

  /**
   * Returns the set of source IDs that pass all filter conditions.
   * Returns null if no filters are active (meaning: all sources allowed).
   */
  getAllowedSourceIds(opts: PreFilterOptions): Set<number> | null {
    if (isPreFilterEmpty(opts)) {
      console.log(`${LOG_PREFIX} No filters active — all sources allowed`);
      return null;
    }

    const rawDb = this.db.getDb();
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    // --- INCLUSION ---

    // Folder includes: path starts with one of the specified prefixes
    if (opts.folderIncludes.length > 0) {
      const folderClauses = opts.folderIncludes.map((f, i) => {
        params[`$folderInc_${i}`] = `${f}%`;
        return `path LIKE $folderInc_${i}`;
      });
      conditions.push(`(${folderClauses.join(' OR ')})`);
      console.log(`${LOG_PREFIX} folderIncludes:`, opts.folderIncludes);
    }

    // Tag includes: all tags must be present in metadata_json
    for (let i = 0; i < opts.tagIncludes.length; i++) {
      params[`$tagInc_${i}`] = `%"${opts.tagIncludes[i]}"%`;
      conditions.push(`metadata_json LIKE $tagInc_${i}`);
    }

    // File name partial match
    if (opts.fileNameIncludes.length > 0) {
      const nameClauses = opts.fileNameIncludes.map((n, i) => {
        params[`$nameInc_${i}`] = `%${n}%`;
        return `title LIKE $nameInc_${i}`;
      });
      conditions.push(`(${nameClauses.join(' OR ')})`);
    }

    // File name exact match
    if (opts.fileNameExact.length > 0) {
      const exactClauses = opts.fileNameExact.map((n, i) => {
        params[`$nameExact_${i}`] = n;
        return `title = $nameExact_${i}`;
      });
      conditions.push(`(${exactClauses.join(' OR ')})`);
    }

    // Date range
    if (opts.createdAfter !== null) {
      params['$createdAfter'] = opts.createdAfter;
      conditions.push(`mtime >= $createdAfter`);
    }
    if (opts.createdBefore !== null) {
      params['$createdBefore'] = opts.createdBefore;
      conditions.push(`mtime <= $createdBefore`);
    }

    // Property key=value pairs (stored as JSON in metadata_json)
    for (let i = 0; i < opts.propertyFilters.length; i++) {
      const prop = opts.propertyFilters[i];
      if (!prop) continue;
      const { key, value } = prop;
      // Match "key":"value" anywhere in the JSON blob
      params[`$prop_${i}`] = `%"${key}":"${value}"%`;
      conditions.push(`metadata_json LIKE $prop_${i}`);
    }

    // --- EXCLUSION ---

    if (opts.folderExcludes.length > 0) {
      const excClauses = opts.folderExcludes.map((f, i) => {
        params[`$folderExc_${i}`] = `${f}%`;
        return `path NOT LIKE $folderExc_${i}`;
      });
      conditions.push(excClauses.join(' AND '));
    }

    for (let i = 0; i < opts.tagExcludes.length; i++) {
      params[`$tagExc_${i}`] = `%"${opts.tagExcludes[i]}"%`;
      conditions.push(`metadata_json NOT LIKE $tagExc_${i}`);
    }

    if (opts.fileNameExcludes.length > 0) {
      const excNameClauses = opts.fileNameExcludes.map((n, i) => {
        params[`$nameExc_${i}`] = `%${n}%`;
        return `title NOT LIKE $nameExc_${i}`;
      });
      conditions.push(excNameClauses.join(' AND '));
    }

    if (opts.excludedSourceIds.length > 0) {
      const placeholders = opts.excludedSourceIds.map((id, i) => {
        params[`$excId_${i}`] = id;
        return `$excId_${i}`;
      }).join(', ');
      conditions.push(`id NOT IN (${placeholders})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id FROM sources ${where}`;
    console.log(`${LOG_PREFIX} SQL: ${sql}`);
    console.log(`${LOG_PREFIX} Params:`, params);

    const stmt = rawDb.prepare(sql);
    stmt.bind(params as any);
    const ids = new Set<number>();
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: number };
      ids.add(row.id);
    }
    stmt.free();

    console.log(`${LOG_PREFIX} Pre-filter returned ${ids.size} allowed source IDs`);
    return ids;
  }
}
