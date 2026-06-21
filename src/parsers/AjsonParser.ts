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
      console.log(`[AjsonParser] parseContent — filePath=${filePath} contentLength=${content.length}`);
      const result: ParseResult = {
        sources: [],
        blocks: [],
        skippedCount: 0,
        errors: [],
      };
      this.parseContentRaw(content, filePath, result);
      return result;
  }

  private parseContentRaw(raw: string, filePath: string, result: ParseResult): void {
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const lineStr = line.trim();
        if (!lineStr) continue;

        let recordData: unknown;
        try {
            // Because NDJSON files from smart connections are structured as: `"/path/to/file.md": {...}`
            // We need to wrap it into `{ "/path/to/file.md": {...} }` before parsing
            recordData = JSON.parse(`{${lineStr}}`);
        } catch (e) {
            const msg = `Failed to JSON.parse line ${i + 1} from ${filePath}: ${String(e)}`;
            console.error(`${LOG_PREFIX} ${msg}`);
            result.errors.push(msg);
            continue;
        }

        if (typeof recordData !== "object" || recordData === null || Array.isArray(recordData)) {
            const msg = `Unexpected top-level type in content from ${filePath} on line ${i + 1}: expected object`;
            console.warn(`${LOG_PREFIX} ${msg}`);
            result.errors.push(msg);
            continue;
        }

        const dict = recordData as Record<string, unknown>;
        for (const [key, val] of Object.entries(dict)) {
            if (typeof val !== "object" || val === null) continue;

            const record = val as Record<string, unknown>;
            const classname = record["classname"] as string | undefined;

            if (classname === "SmartSource") {
                this.parseSource(key, record, result);
            } else if (classname === "SmartBlock") {
                this.parseBlock(key, record, result);
            } else {
                if (this.enableDebugLogging) {
                    console.log(`${LOG_PREFIX} Skipping record with key=${key}, classname=${classname}`);
                }
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
    recordKey: string,
    record: Record<string, unknown>,
    result: ParseResult
  ): void {
    // Required field: path
    const path_ = this.extractPath(record, recordKey);
    if (!path_) {
      const msg = `SmartSource record key=${recordKey} has no resolvable path — skipping`;
      console.warn(`${LOG_PREFIX} ${msg}`);
      result.skippedCount++;
      result.errors.push(msg);
      return;
    }

    const title = this.deriveTitle(path_);
    const hash = this.extractHash(record);
    const embedHash = this.extractEmbedHash(record);
    const mtime = this.extractMtime(record);
    const outlinks = this.extractOutlinks(record);
    const embeddings = this.extractEmbeddings(record, path_);

    // Strip known structural keys; remaining fields go into metadata
    const metadata = this.extractMetadata(record, [
      "classname", "path", "key", "outlinks",
      "last_read", "last_embed", "id", "collection_key",
    ]);

    const parsed: ParsedSource = {
      path: path_,
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
      console.log(`${LOG_PREFIX} Parsed SmartSource: ${path_}`, {
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
    recordKey: string,
    record: Record<string, unknown>,
    result: ParseResult
  ): void {
    // Required: block_key (fall back to the map key itself)
    const blockKey = (record["key"] as string | undefined) || recordKey;
    if (!blockKey) {
      const msg = `SmartBlock record has no key — skipping`;
      console.warn(`${LOG_PREFIX} ${msg}`);
      result.skippedCount++;
      result.errors.push(msg);
      return;
    }

    // Derive parent path: blockKey format is "path/to/note.md#{anchor}"
    const blockPath = this.deriveBlockPath(blockKey);
    if (!blockPath) {
      const msg = `SmartBlock key=${blockKey} — cannot derive parent path — skipping`;
      console.warn(`${LOG_PREFIX} ${msg}`);
      result.skippedCount++;
      result.errors.push(msg);
      return;
    }

    const lineStart = this.extractLineNumber(record, "line_start");
    const lineEnd = this.extractLineNumber(record, "line_end");
    const text = (record["text"] as string | undefined) || "";
    const blockLabel = this.deriveBlockLabel(blockKey, text);
    const hash = this.extractHash(record);
    const embedHash = this.extractEmbedHash(record);
    const outlinks = this.extractOutlinks(record);
    const embeddings = this.extractEmbeddings(record, blockKey);

    const metadata = this.extractMetadata(record, [
      "classname", "key", "text", "line_start", "line_end",
      "outlinks", "last_read", "last_embed", "id", "collection_key",
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
      console.log(`${LOG_PREFIX} Parsed SmartBlock: ${blockKey}`, {
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
    const candidates = [
      record["path"],
      record["key"],
      fallback,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) {
        // Accept paths that look like vault note paths (contain / or end with .md)
        // Reject Smart Connections collection keys like "smart_sources:" etc.
        const s = c.trim();
        if (!s.includes(":") || s.endsWith(".md")) {
          return s;
        }
      }
    }
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
    const raw = record["outlinks"];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v) => typeof v === "string");
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

    for (const [key, value] of Object.entries(record)) {
      // Heuristic: model name keys contain "/" (e.g. "TaylorAI/bge-micro-v2")
      // or start with known prefixes. Check for a "vec" array child.
      if (typeof value !== "object" || value === null) continue;
      const embObj = value as Record<string, unknown>;
      if (!Array.isArray(embObj["vec"])) continue;

      const vec = embObj["vec"] as unknown[];
      const numericVec = vec.filter((v) => typeof v === "number");

      if (numericVec.length === 0) {
        console.warn(
          `${LOG_PREFIX} Empty or non-numeric vec for model=${key} owner=${ownerKey} — skipping embedding`
        );
        continue;
      }

      if (numericVec.length !== vec.length) {
        console.warn(
          `${LOG_PREFIX} vec for model=${key} owner=${ownerKey} has non-numeric entries — using numeric subset (${numericVec.length}/${vec.length})`
        );
      }

      results.push({
        modelName: key,
        vec: numericVec,
        dim: numericVec.length,
      });

      if (this.enableDebugLogging) {
        console.log(`${LOG_PREFIX} Extracted embedding model=${key} dim=${numericVec.length} owner=${ownerKey}`);
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
