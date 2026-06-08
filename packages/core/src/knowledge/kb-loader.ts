import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const KB_ROOT = process.env.HEX4_KB_ROOT || path.join(os.homedir(), ".hex4code", "knowledge-base");

export type KbEntry = {
  id: string;
  title: string;
  category: string;
  content: string;
  file: string;
};

let kbCache: KbEntry[] | null = null;

function walkMd(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".md")) results.push(full);
      else if (e.isDirectory() && !e.name.startsWith(".")) results.push(...walkMd(full));
    }
  } catch {
    /* skip */
  }
  return results;
}

function chunkFile(filePath: string): KbEntry[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const entries: KbEntry[] = [];
  let currentTitle = path.basename(filePath, ".md");
  let currentContent: string[] = [];
  const relPath = path.relative(KB_ROOT, filePath);
  const category = relPath.split(/[\\/]/)[0] || "root";
  let paraId = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentContent.length > 0 && currentContent.join("").trim()) {
        entries.push({
          id: relPath + "-" + String(paraId++),
          title: currentTitle,
          category,
          content: currentContent.join("\n").trim(),
          file: relPath,
        });
      }
      currentTitle = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentContent.length > 0 && currentContent.join("").trim()) {
    entries.push({
      id: relPath + "-" + String(paraId++),
      title: currentTitle,
      category,
      content: currentContent.join("\n").trim(),
      file: relPath,
    });
  }
  return entries;
}

export function loadKnowledgeBase(): KbEntry[] {
  if (kbCache) return kbCache;
  if (!fs.existsSync(KB_ROOT)) {
    console.warn("[KB] Knowledge base not found:", KB_ROOT);
    kbCache = [];
    return kbCache;
  }
  const files = walkMd(KB_ROOT);
  kbCache = [];
  for (const f of files) {
    try {
      kbCache.push(...chunkFile(f));
    } catch (e) {
      console.warn("[KB] Error reading", f, e);
    }
  }
  console.log("[KB] Loaded " + String(kbCache.length) + " chunks from " + String(files.length) + " files");
  return kbCache;
}

export function searchKnowledgeBase(query: string, topK = 5): KbEntry[] {
  const all = loadKnowledgeBase();
  const ql = query.toLowerCase();
  const scored = all.map((e) => {
    const content = e.content.toLowerCase();
    let score = 0;
    if (e.title.toLowerCase().includes(ql)) score += 10;
    if (content.includes(ql)) score += 5;
    const words = ql.split(/\s+/);
    for (const w of words) {
      if (w.length > 1 && content.includes(w)) score += 1;
    }
    return { entry: e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, topK)
    .filter((s) => s.score > 0)
    .map((s) => s.entry);
}

export function formatKbResults(results: KbEntry[]): string {
  if (results.length === 0) return "No relevant knowledge found.";
  return results
    .map((r, i) => {
      const snippet = r.content.length > 400 ? r.content.substring(0, 400) + "..." : r.content;
      return "[" + String(i + 1) + "] " + r.title + " (" + r.category + "/" + r.file + ")\n" + snippet;
    })
    .join("\n---\n");
}
