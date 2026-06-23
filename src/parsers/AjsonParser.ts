import * as fs from "fs";
import * as path from "path";
import type {
  ParsedSource,
  ParsedBlock,
  ParsedEmbedding,
  ParseResult,
} from "../types";

const LOG_PREFIX = "[AjsonParser]";

export class AjsonParser {
  private enableDebugLogging: boolean;

  constructor(enableDebugLogging = true) {
    this.enableDebugLogging = enableDebugLogging;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public parseContent(content: string, filePath: string): ParseResult {
      console.log('[AjsonParser] parseFile ENTER', {
        filePath,
        rawLength: content?.length,
        isUndefined: content === undefined,
        isNull: content === null,
      });

      const result: ParseResult = {
        sources: [],
        blocks: [],
        skippedCount: 0,
        errors: [],
      };
      this.parseContentRaw(content, filePath, result);

      console.log('[AjsonParser] parseFile EXIT', {
        filePath,
        embeddingsCount: result.sources.reduce((a, s) => a + s.embeddings.length, 0) + result.blocks.reduce((a, b) => a + b.embeddings.length, 0),
      });

      return result;
  }

  private parseContentRaw(raw: string, filePath: string, result: ParseResult): void {
    console.log(`[AjsonParser] parse start`, { filePath });

    const rawPreview = raw.slice(0, 200).replace(/\n/g, '\\n');
    console.log(`[AjsonParser] raw file stats`, {
      filePath,
      rawLength: raw.length,
      startsWithNewline: raw.startsWith('\n'),
      preview: rawPreview,
    });

    // Strip any leading newlines (some files start with \n, some don't)
    // Then split on newline to get individual records
    const normalized = raw.replace(/^\s+/, '');
    const lines = normalized.trim().split('\n').map(l => l.trim()).filter(Boolean);

    console.log(`[AjsonParser] normalized lines`, {
      filePath,
      lineCount: lines.length,
      firstLinePreview: lines[0]?.slice(0, 160),
      secondLinePreview: lines[1]?.slice(0, 160),
    });

    let processedCount = 0;

    for (let i = 0; i < lines.length; i++) {
        // Strip whitespace then strip the trailing comma SC appends to every line
        const rawLine = lines[i];
        if (rawLine === undefined) continue;

        const line = rawLine.trim().replace(/,$/, '');
        if (!line) continue; // blank lines between records are normal

        const wrapped = `{${line}}`;
        console.log(`[AjsonParser] parsing line`, {
          filePath,
          lineIndex: i,
          preview: wrapped.slice(0, 200),
        });

        // Wrap in {} to make a valid JSON object: "key": {val} → {"key": {val}}
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(wrapped);
        } catch (e) {
            console.log(`[AjsonParser] JSON parse failed`, {
              filePath,
              lineIndex: i,
              error: String(e),
              rawLinePreview: line.slice(0, 200),
              wrappedPreview: wrapped.slice(0, 200),
            });
            result.errors.push(`Line ${i + 1} in ${filePath}: ${String(e)}`);
            continue;
        }

        // Each parsed object has exactly one top-level key
        for (const [rawKey, val] of Object.entries(parsed)) {
            if (typeof val !== 'object' || val === null || Array.isArray(val)) continue;
            const record = val as Record<string, unknown>;

            if (rawKey.startsWith('smart_sources:')) {
                // Strip prefix to get the vault-relative path
                const vaultPath = rawKey.substring('smart_sources:'.length);
                this.parseSource(vaultPath, record, result);
            } else if (rawKey.startsWith('smart_blocks:')) {
                // Strip prefix to get the block key (format: path/to/note.md#Heading)
                const blockKey = rawKey.substring('smart_blocks:'.length);
                this.parseBlock(blockKey, record, result);
            } else {
                if (this.enableDebugLogging) {
                    console.log(`[AjsonParser] Line ${i + 1}: unrecognised key prefix — key=${rawKey.substring(0, 60)}`);
                }
            }
        }
        processedCount++;
    }

    console.log(`[AjsonParser] parse complete`, {
      filePath,
      sourceRecords: result.sources.length,
      blockRecords: result.blocks.length,
      embeddingRecords: result.sources.reduce((a, s) => a + s.embeddings.length, 0) + result.blocks.reduce((a, b) => a + b.embeddings.length, 0),
      models: Array.from(new Set([
        ...result.sources.flatMap(s => s.embeddings.map(e => e.modelName)),
        ...result.blocks.flatMap(b => b.embeddings.map(e => e.modelName))
      ])).slice(0, 10),
    });

    if (result.sources.length > 0) {
        const source0 = result.sources[0];
        if (source0 && source0.embeddings.length > 0) {
            const sample = source0.embeddings[0];
            if (sample) {
                console.log('[AjsonParser] sample source embedding', {
                    ownerType: 'source',
                    ownerId: source0.path,
                    modelName: sample.modelName,
                    dim: sample.vec?.length,
                    first3: sample.vec?.slice(0, 3),
                });
            }
        }
    }

    if (result.blocks.length > 0) {
        const block0 = result.blocks[0];
        if (block0 && block0.embeddings.length > 0) {
            const sampleBlock = block0.embeddings[0];
            if (sampleBlock) {
                console.log('[AjsonParser] sample block embedding', {
                    ownerType: 'block',
                    ownerId: block0.blockKey,
                    modelName: sampleBlock.modelName,
                    dim: sampleBlock.vec?.length,
                    first3: sampleBlock.vec?.slice(0, 3),
                });
            }
        }
    }
  }

  /**
   * Parse a single .ajson file (or a directory of .ajson files) and return
   * all discovered sources and blocks.
   *
   * @param inputPath  Absolute path to a .ajson file OR a directory containing .ajson files.
   */
  async parseFile(inputPath: string): Promise<ParseResult> {
    console.log(`${LOG_PREFIX} parseFile called`, { inputPath });

    const result: ParseResult = {
      sources: [],
      blocks: [],
      skippedCount: 0,
      errors: [],
    };

    let stat: fs.Stats;
    try {
      stat = fs.statSync(inputPath);
    } catch (e) {
      const msg = `Cannot stat input path: ${inputPath} — ${String(e)}`;
      console.error(`${LOG_PREFIX} ${msg}`);
      result.errors.push(msg);
      return result;
    }

    const files: string[] = [];

    if (stat.isDirectory()) {
      console.log(`${LOG_PREFIX} Input is a directory, scanning for .ajson files`);
      const entries = fs.readdirSync(inputPath);
      for (const entry of entries) {
        if (entry.endsWith(".ajson")) {
          files.push(path.join(inputPath, entry));
        }
      }
      console.log(`${LOG_PREFIX} Found ${files.length} .ajson file(s)`);
    } else {
      files.push(inputPath);
    }

    for (const filePath of files) {
      console.log(`${LOG_PREFIX} Parsing file: ${filePath}`);
      this.parseOneFile(filePath, result);
    }

    console.log(`${LOG_PREFIX} Parse complete`, {
      sources: result.sources.length,
      blocks: result.blocks.length,
      skipped: result.skippedCount,
      errors: result.errors.length,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private: parse one .ajson file
  // ---------------------------------------------------------------------------

  private parseOneFile(filePath: string, result: ParseResult): void {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      const msg = `Failed to read file ${filePath}: ${String(e)}`;
      console.error(`${LOG_PREFIX} ${msg}`);
      result.errors.push(msg);
      return;
    }

    this.parseContentRaw(raw, filePath, result);
  }

  // ---------------------------------------------------------------------------
  // Private: parse a SmartSource record
  // ---------------------------------------------------------------------------

  private parseSource(
    vaultPath: string,
    record: Record<string, unknown>,
    result: ParseResult
  ): void {
    // Skip metadata-only lines (embeddings field exists but is empty {})
    const embeddings = this.extractEmbeddings(record, vaultPath);
    if (embeddings.length === 0) {
        if (this.enableDebugLogging) {
            console.log(`[AjsonParser] SmartSource ${vaultPath.substring(0, 60)} — no embeddings, skipping (metadata-only line)`);
        }
        result.skippedCount++;
        return;
    }

    const title = this.deriveTitle(vaultPath);
    const hash = this.extractHash(record);
    const embedHash = this.extractEmbedHash(record);
    const mtime = this.extractMtime(record);
    const outlinks = this.extractOutlinks(record);
    const metadata = this.extractMetadata(record, [
        'path', 'key', 'outlinks', 'embeddings',
        'last_read', 'last_embed', 'id', 'collection_key', 'blocks',
    ]);

    const parsed: ParsedSource = {
        path: vaultPath,
        title,
        hash,
        embedHash,
        mtime,
        outlinks,
        metadata,
        rawJson: JSON.stringify(record),
        embeddings,
    };

    if (this.enableDebugLogging) {
        console.log(`[AjsonParser] Parsed SmartSource: ${vaultPath.substring(0, 60)}`, {
            embeddingCount: embeddings.length,
            outlinks: outlinks.length,
            hash,
        });
    }

    result.sources.push(parsed);
  }

  // ---------------------------------------------------------------------------
  // Private: parse a SmartBlock record
  // ---------------------------------------------------------------------------

  private parseBlock(
    blockKey: string,
    record: Record<string, unknown>,
    result: ParseResult
  ): void {
    if (!blockKey) {
        result.skippedCount++;
        return;
    }

    // Skip blocks with no embeddings
    const embeddings = this.extractEmbeddings(record, blockKey);
    if (embeddings.length === 0) {
        if (this.enableDebugLogging) {
            console.log(`[AjsonParser] SmartBlock ${blockKey.substring(0, 60)} — no embeddings, skipping`);
        }
        result.skippedCount++;
        return;
    }

    const blockPath = this.deriveBlockPath(blockKey);
    if (!blockPath) {
        const msg = `SmartBlock key=${blockKey} — cannot derive parent path — skipping`;
        console.warn(`[AjsonParser] ${msg}`);
        result.skippedCount++;
        result.errors.push(msg);
        return;
    }

    const lineStart = this.extractLineNumber(record, 'line_start');
    const lineEnd = this.extractLineNumber(record, 'line_end');
    const text = (record['text'] as string | undefined) ?? '';
    const blockLabel = this.deriveBlockLabel(blockKey, text);
    const hash = this.extractHash(record);
    const embedHash = this.extractEmbedHash(record);
    const outlinks = this.extractOutlinks(record);

    const metadata = this.extractMetadata(record, [
        'key', 'text', 'line_start', 'line_end',
        'outlinks', 'embeddings', 'last_read', 'last_embed', 'id', 'collection_key',
    ]);

    const parsed: ParsedBlock = {
        blockKey,
        blockPath,
        blockLabel,
        lineStart,
        lineEnd,
        text,
        textLength: text.length,
        hash,
        embedHash,
        outlinks,
        metadata,
        rawJson: JSON.stringify(record),
        embeddings,
    };

    if (this.enableDebugLogging) {
        console.log(`[AjsonParser] Parsed SmartBlock: ${blockKey.substring(0, 60)}`, {
            lines: `${lineStart}-${lineEnd}`,
            embeddingCount: embeddings.length,
        });
    }

    result.blocks.push(parsed);
  }

  // ---------------------------------------------------------------------------
  // Private: field extractors
  // ---------------------------------------------------------------------------

  /**
   * Resolve the vault-relative path from a SmartSource record.
   * The path may live under record.path, record.key, or the map key itself.
   */
  private extractPath(record: Record<string, unknown>, fallback: string): string | null {
    // vaultPath is already stripped of smart_sources: prefix at call site
    // fallback IS the vault path — use it directly
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
        return fallback.trim();
    }
    const p = record['path'];
    if (typeof p === 'string' && p.trim().length > 0) return p.trim();
    return null;
  }

  /**
   * For blocks: derive the parent note path from a block key.
   * Block keys follow the pattern "path/to/note.md#{anchor}" or
   * "path/to/note.md#{lineStart}-{lineEnd}".
   * Return the part before the first "#".
   */
  private deriveBlockPath(blockKey: string): string | null {
    const hashIdx = blockKey.indexOf("#");
    if (hashIdx === -1) return null;
    const p = blockKey.substring(0, hashIdx);
    return p.length > 0 ? p : null;
  }

  private deriveTitle(notePath: string): string {
    const base = notePath.split("/").pop() ?? notePath;
    return base.endsWith(".md") ? base.slice(0, -3) : base;
  }

  private deriveBlockLabel(blockKey: string, text: string): string {
    // Use the anchor part of the key as primary label
    const hashIdx = blockKey.indexOf("#");
    if (hashIdx !== -1) {
      const anchor = blockKey.substring(hashIdx + 1);
      if (anchor.length > 0 && anchor.length <= 120) return anchor;
    }
    // Fall back to first 80 chars of text
    if (text.length > 0) return text.substring(0, 80).replace(/\n/g, " ");
    return blockKey;
  }

  private extractHash(record: Record<string, unknown>): string {
    try {
      const lr = record["last_read"] as Record<string, unknown> | undefined;
      if (lr && typeof lr["hash"] === "string") return lr["hash"];
    } catch {}
    return "";
  }

  private extractEmbedHash(record: Record<string, unknown>): string {
    try {
      const le = record["last_embed"] as Record<string, unknown> | undefined;
      if (le && typeof le["hash"] === "string") return le["hash"];
    } catch {}
    return "";
  }

  private extractMtime(record: Record<string, unknown>): number {
    try {
      const lr = record["last_read"] as Record<string, unknown> | undefined;
      if (lr && typeof lr["mtime"] === "number") return lr["mtime"];
    } catch {}
    return 0;
  }

  private extractOutlinks(record: Record<string, unknown>): string[] {
    const raw = record['outlinks'];
    if (!Array.isArray(raw)) return [];
    // Each entry is an object: { title: string, target: string, line: number }
    return raw
        .filter(v => typeof v === 'object' && v !== null)
        .map(v => (v as Record<string, unknown>)['target'] as string)
        .filter(t => typeof t === 'string' && t.length > 0);
  }

  private extractLineNumber(
    record: Record<string, unknown>,
    field: "line_start" | "line_end"
  ): number {
    const v = record[field];
    if (typeof v === "number") return v;
    return 0;
  }

  /**
   * Extract all embedding vectors from a record.
   * Smart Connections stores embeddings under the model name as a key, e.g.:
   *   record["TaylorAI/bge-micro-v2"] = { vec: [...], dim: 384, tokens: 64, ... }
   *
   * We identify embedding fields by checking whether the key looks like a model
   * name (contains "/" or "-" and whose value has a "vec" array).
   */
  private extractEmbeddings(
    record: Record<string, unknown>,
    ownerKey: string
  ): ParsedEmbedding[] {
    const results: ParsedEmbedding[] = [];

    // Real SC structure: record.embeddings = { "TaylorAI/bge-micro-v2": { vec: [...], tokens: N } }
    const embeddingsField = record['embeddings'];
    if (typeof embeddingsField !== 'object' || embeddingsField === null) {
        return results;
    }

    for (const [modelName, embData] of Object.entries(embeddingsField as Record<string, unknown>)) {
        if (typeof embData !== 'object' || embData === null) continue;
        const embObj = embData as Record<string, unknown>;
        if (!Array.isArray(embObj['vec'])) continue;

        const vec = (embObj['vec'] as unknown[]).filter(v => typeof v === 'number') as number[];
        if (vec.length === 0) {
            console.warn(`[AjsonParser] Empty vec for model=${modelName} owner=${ownerKey.substring(0, 60)}`);
            continue;
        }

        results.push({ modelName, vec, dim: vec.length });

        if (this.enableDebugLogging) {
            console.log(`[AjsonParser] Extracted embedding model=${modelName} dim=${vec.length} owner=${ownerKey.substring(0, 60)}`);
        }
    }

    return results;
  }

  /**
   * Return all fields from a record except the listed structural keys,
   * as a plain object for storage as metadata_json.
   */
  private extractMetadata(
    record: Record<string, unknown>,
    excludeKeys: string[]
  ): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const exclude = new Set(excludeKeys);
    for (const [k, v] of Object.entries(record)) {
      if (exclude.has(k)) continue;
      // Also exclude model-name keys that contain vec arrays (those are embeddings)
      if (
        typeof v === "object" &&
        v !== null &&
        Array.isArray((v as Record<string, unknown>)["vec"])
      )
        continue;
      meta[k] = v;
    }
    return meta;
  }
}
