// main.ts is mend, the CLI SPEC.md specifies. It implements every section of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One move a successful edit made, for the `R` output row (SPEC.md section 2). */
interface Move {
  old: string;
  new: string;
}

/** A file as lines plus its line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function writeFile(model: FileModel): string {
  if (model.lines.length === 0) return '';
  return model.lines.join(model.br) + (model.final ? model.br : '');
}

/** A line compared at one matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Positions at or after `from` where O's lines match the file's lines at `tier`. */
function occurrencesFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or null (SPEC.md section 5). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrencesFrom(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line takes the file's own line, any other is written as given. */
interface Slot {
  ctx: boolean;
  text: string;
  oIdx: number;
}

/** The lines that replace a matched region (SPEC.md section 5). */
function replacementLines(fileLines: string[], at: number, o: string[], slots: Slot[], tier: number): string[] {
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  const out: string[] = [];
  for (const s of slots) {
    if (s.ctx) {
      out.push(fileLines[at + s.oIdx]!);
      continue;
    }
    let t = s.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** A hunk or chunk body line. `raw` is the patch line as written. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '', raw: line };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), raw: line };
  if (c === '-') return { kind: 'old', text: line.slice(1), raw: line };
  if (c === '+') return { kind: 'new', text: line.slice(1), raw: line };
  return { kind: 'bs', text: line, raw: line };
}

/** O (context and old lines) and the N slots of a hunk or chunk body. */
function bodyParts(body: BodyLine[]): { o: string[]; slots: Slot[] } {
  const o: string[] = [];
  const slots: Slot[] = [];
  let oCount = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      slots.push({ ctx: true, text: b.text, oIdx: oCount });
      oCount += 1;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oCount += 1;
    } else if (b.kind === 'new') {
      slots.push({ ctx: false, text: b.text, oIdx: -1 });
    }
  }
  return { o, slots };
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6). */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
    }
  }
  return false;
}

/** Apply one unified hunk to the file model; returns N's length minus O's length. */
function applyHunk(model: FileModel, hunk: { a: number; body: BodyLine[] }, d: number, strict: boolean, path: string): number {
  const { o, slots } = bodyParts(hunk.body);
  const noBreak = backslashAfterLast(hunk.body);
  if (o.length === 0) {
    const pos = Math.max(0, Math.min(hunk.a + d, model.lines.length));
    const atEnd = pos === model.lines.length;
    const ins = slots.map((s) => s.text);
    model.lines.splice(pos, 0, ...ins);
    if (atEnd) model.final = !noBreak;
    return ins.length;
  }
  const found = findTier(model.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let at = found.occ[0]!;
  let best = Math.abs(at - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      at = p;
    }
  }
  const rep = replacementLines(model.lines, at, o, slots, found.tier);
  const ranToEnd = at + o.length === model.lines.length;
  model.lines.splice(at, o.length, ...rep);
  if (ranToEnd) model.final = !noBreak;
  return rep.length - o.length;
}

/** One unified-diff section (SPEC.md section 6). */
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: { a: number; body: BodyLine[] }[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path a `--- ` or `+++ ` line names, null for `/dev/null`. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkHeader(line: string, i: number): { a: number; body: BodyLine[] } {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return { a: Number(m[1]), body: [] };
}

/** The text of a created file: the `+` lines of every hunk, ended by a line break. */
function createText(hunks: { a: number; body: BodyLine[] }[]): string {
  const plus: string[] = [];
  let noBreak = false;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k += 1) {
      if (h.body[k]!.kind === 'new') {
        plus.push(h.body[k]!.text);
        noBreak = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noBreak ? '' : '\n');
}

/** One unified-diff section as an edit (SPEC.md sections 6 and 10). */
function sectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : (sec.renFrom ?? sec.gitOld);
  const newPath = sec.pairNew !== undefined ? sec.pairNew : (sec.renTo ?? sec.gitNew);
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (newPath === null) kind = 'delete';
  else if (oldPath === null) kind = 'create';
  else if (sec.newFile) kind = 'create';
  else if (sec.delFile) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (kind === 'create') {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createText(sec.hunks));
      return;
    }
    if (kind === 'delete') {
      const p = oldPath ?? '/dev/null';
      if (oldPath !== null && !safe(p)) throw new Fail('unsafe', p);
      if (oldPath === null || tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'move' && !safe(newPath!)) throw new Fail('unsafe', newPath!);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (kind === 'move' && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(model, h, d, strict, p);
    const text = writeFile(model);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newPath!, text);
      moves.push({ old: p, new: newPath! });
    } else {
      tree.now.set(p, text);
    }
  };
}

/** Read a patch as unified diffs (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  const fresh = (gitOld: string | null, gitNew: string | null): Section => ({
    gitOld,
    gitNew,
    pairOld: undefined,
    pairNew: undefined,
    renFrom: null,
    renTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let curHunk: { a: number; body: BodyLine[] } | null = null;
  const finishHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.raw === '') curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  const startGitSection = (line: string, i: number): void => {
    const m = GIT_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    cur = fresh(m[1]!, m[2]!);
    sections.push(cur);
    state = 'header';
  };
  const startPairSection = (line: string, next: string): void => {
    cur = fresh(null, null);
    sections.push(cur);
    cur.pairOld = headerPath(line);
    cur.pairNew = headerPath(next);
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startPairSection(line, lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('@@')) {
        curHunk = parseHunkHeader(line, i);
        state = 'body';
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        startGitSection(line, i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.pairOld = headerPath(line);
        cur!.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur!.renFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        finishHunk();
        startGitSection(line, i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        startPairSection(line, lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        finishHunk();
        curHunk = parseHunkHeader(line, i);
        i += 1;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        curHunk!.body.push(bodyLine(line));
        i += 1;
        continue;
      }
      finishHunk();
      state = 'after';
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      startGitSection(line, i);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startPairSection(line, lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      curHunk = parseHunkHeader(line, i);
      state = 'body';
      i += 1;
      continue;
    }
    i += 1;
  }
  if (state === 'body') finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict, moves));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function searchReplaceEdit(block: { path: string; oldLines: string[]; newLines: string[] }, strict: boolean): Edit {
  return (tree) => {
    if (!safe(block.path)) throw new Fail('unsafe', block.path);
    if (block.oldLines.length === 0) {
      if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
      tree.now.set(block.path, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(block.path);
    if (before === null) throw new Fail('missing', block.path);
    const model = parseFile(before);
    const found = findTier(model.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', block.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', block.path);
    const at = found.occ[0]!;
    const slots: Slot[] = block.newLines.map((t) => ({ ctx: false, text: t, oIdx: -1 }));
    const rep = replacementLines(model.lines, at, block.oldLines, slots, found.tier);
    model.lines.splice(at, block.oldLines.length, ...rep);
    tree.now.set(block.path, writeFile(model));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let k = i + 1;
    for (; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let m = eq + 1; m < lines.length; m += 1) {
      const t = lines[m]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = m;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

/** One V4A chunk (SPEC.md section 8). */
interface V4aChunk {
  anchor: string;
  eof: boolean;
  body: BodyLine[];
}

/** One V4A section. */
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addRaw: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

/** Apply one V4A chunk to the file model; returns the cursor after the lines written. */
function applyV4aChunk(model: FileModel, chunk: V4aChunk, cursor: number, strict: boolean, path: string): number {
  const { o, slots } = bodyParts(chunk.body);
  let cur = cursor;
  if (chunk.anchor !== '') {
    let foundAt = -1;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && foundAt < 0; t += 1) {
      const a = normLine(chunk.anchor, t);
      for (let j = cur; j < model.lines.length; j += 1) {
        if (normLine(model.lines[j]!, t) === a) {
          foundAt = j;
          break;
        }
      }
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  if (o.length === 0) {
    const pos = chunk.eof ? model.lines.length : cur;
    const ins = slots.map((s) => s.text);
    model.lines.splice(pos, 0, ...ins);
    return pos + ins.length;
  }
  const found = findTier(model.lines, o, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let at = -1;
  for (const p of found.occ) {
    if (!chunk.eof || p + o.length === model.lines.length) {
      at = p;
      break;
    }
  }
  if (at < 0) throw new Fail('no-match', path);
  const rep = replacementLines(model.lines, at, o, slots, found.tier);
  model.lines.splice(at, o.length, ...rep);
  return at + rep.length;
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aEdit(sec: V4aSection, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const files = sec.addRaw.map((l) => (l.startsWith('+') ? l.slice(1) : ''));
      tree.now.set(sec.path, files.length === 0 ? '' : files.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) cursor = applyV4aChunk(model, ch, cursor, strict, sec.path);
    const text = writeFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

/** Read a patch as a V4A patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: V4aSection = { kind: 'add', path: line.slice(14).trim(), lineNo: i + 1, addRaw: [], moveTo: null, chunks: [] };
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          sec.addRaw.push(l);
          i += 1;
          continue;
        }
        if (blank(l)) {
          sec.addRaw.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.addRaw.length > 0 && blank(sec.addRaw[sec.addRaw.length - 1]!)) sec.addRaw.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const sec: V4aSection = { kind: 'delete', path: line.slice(17).trim(), lineNo: i + 1, addRaw: [], moveTo: null, chunks: [] };
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) {
          i += 1;
          continue;
        }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: V4aSection = { kind: 'update', path: line.slice(17).trim(), lineNo: i + 1, addRaw: [], moveTo: null, chunks: [] };
      i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      let curChunk: V4aChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk !== null) {
          sec.chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          pushChunk();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          pushChunk();
          curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: '', eof: false, body: [] };
          }
          curChunk.body.push(bodyLine(l));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushChunk();
      const lc = sec.chunks[sec.chunks.length - 1];
      if (lc !== undefined && !lc.eof) {
        while (lc.body.length > 0 && blank(lc.body[lc.body.length - 1]!.raw)) lc.body.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict, moves));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
