// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

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
  /** Successful moves, [old, new], in the order the edits made them; the output phase turns a pair into an `R` line when the old path existed before the patch and is gone after it and the new path did not exist before it and does after it. */
  readonly moves: Array<[string, string]> = [];
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

/** A text file as lines: its line break (CRLF when its first line feed follows a carriage return, LF otherwise), its lines split at that break, and whether it ends with a line break (SPEC.md section 3). An empty file has no lines and does not end with a line break. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Trailing spaces and tabs only (never a carriage return: lines never hold one after the split). */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
/** Leading and trailing spaces and tabs. */
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** Leading spaces and tabs. */
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs at least once at or after `from`, with every occurrence at
 * that tier. With --strict only tier 0 is tried. Null when O occurs at no tier.
 */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, from, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: a context line is written as the file's own matched line, a new line as the patch wrote it (SPEC.md section 5). */
interface NewLine {
  text: string;
  ctx: boolean;
  /** Index within O of the context line this replaces; -1 for a new line. */
  oIdx: number;
}

/**
 * The lines that replace the k matched lines at `start`. At tier 2 every other (non-context)
 * line that is not empty and not only whitespace and starts with P (the leading spaces and tabs
 * of O's first line) has that P replaced by F (the leading spaces and tabs of the file's first
 * matched line). At tiers 0 and 1 the lines of N are written as they are.
 */
function buildReplacement(fileLines: string[], start: number, o: string[], n: NewLine[], tier: number): string[] {
  if (n.length === 0) return [];
  const f = tier === 2 && o.length > 0 ? leadST(fileLines[start]!) : '';
  const p = tier === 2 && o.length > 0 ? leadST(o[0]!) : '';
  return n.map((nl) => {
    if (nl.ctx) return fileLines[start + nl.oIdx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

/** One body line of a hunk: ' ' context, '-' old, '+' new, '\' a backslash line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** One hunk: its header's old start A (B and D are not used) and its body. */
interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

/** One section: one edit. A null path is `/dev/null`, no file. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed, a leading `a/` or `b/` removed. `/dev/null` means no file. */
function diffPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text; its A, or null. */
function hunkA(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

/**
 * Read one hunk body starting at `i` (the line after the header). The body is the lines that
 * start with ` `, `-`, `+` or `\`, or are empty (an empty line is a context line whose text is
 * empty); it ends at the first other line. Empty lines at the end of a body are not part of it.
 * Returns the hunk and the index of the first line after the body.
 */
function readHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `diff --git ` line and at a `--- ` line followed by a `+++ ` line
    // (which starts a new section); a `--- ` line on its own is an old line, it starts with `-`.
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: ' ', text: '' });
    else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
    else if (l[0] === '\\') body.push({ kind: '\\', text: l });
    else break;
    j++;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      noEol = body[k + 1]?.kind === '\\';
      break;
    }
  }
  return { hunk: { a: 0, body, noEol }, next: j };
}

/** O is the hunk's context and `-` lines, N its context and `+` lines, each in body order. */
function hunkOld(h: Hunk): string[] {
  return h.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
}

function hunkNew(h: Hunk): NewLine[] {
  const out: NewLine[] = [];
  let oIdx = 0;
  for (const b of h.body) {
    if (b.kind === ' ') {
      out.push({ text: b.text, ctx: true, oIdx });
      oIdx++;
    } else if (b.kind === '-') {
      oIdx++;
    } else if (b.kind === '+') {
      out.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return out;
}

/**
 * Apply a section's hunks in order, each to the result of the ones before it. d is the sum over
 * the hunks applied so far of (N's length minus O's length). Throws Fail('no-match', path) when
 * a hunk's O is found at no tier.
 */
function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = fs;
  let d = 0;
  for (const h of hunks) {
    const o = hunkOld(h);
    const n = hunkNew(h);
    if (o.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const ins = buildReplacement(cur.lines, at, [], n, 0);
      const lines = [...cur.lines.slice(0, at), ...ins, ...cur.lines.slice(at)];
      const touchesEnd = at === cur.lines.length;
      cur = { lines, br: cur.br, final: touchesEnd ? !h.noEol : cur.final };
      d += n.length;
    } else {
      const found = firstTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchesEnd = best + o.length === cur.lines.length;
      const repl = buildReplacement(cur.lines, best, o, n, found.tier);
      const lines = [...cur.lines.slice(0, best), ...repl, ...cur.lines.slice(best + o.length)];
      cur = { lines, br: cur.br, final: touchesEnd ? !h.noEol : cur.final };
      d += n.length - o.length;
    }
  }
  return cur;
}

/** Whether a `\` line follows the last `+` line of a creation section, across all its hunks. */
function createNoEol(sec: Section): boolean {
  for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
    const body = sec.hunks[hi]!.body;
    for (let bi = body.length - 1; bi >= 0; bi--) {
      if (body[bi]!.kind === '+') return body[bi + 1]?.kind === '\\';
    }
  }
  return false;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    if (sec.kind === 'noop') return;
    if (sec.kind === 'create') {
      const p = sec.newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (createNoEol(sec) ? '' : '\n'));
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.kind === 'move') {
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(splitFile(cur), sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(after));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = sec.oldPath!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(cur), sec.hunks, strict, p)));
  };
}

/**
 * Parse the header and hunks of one section starting at `i`, and return the section with the
 * index of the next unprocessed line (the next section's start, or the end of the patch).
 * A `--- ` line not followed by a `+++ ` line, inside the section's header, is
 * `error: parse <the line after it>`. A `diff --git` line not of the form above, and any other
 * line starting with `@@`, is `error: parse <its line>`; so is a hunk before any section.
 */
function parseSection(lines: string[], i: number, git: [string, string] | null): { sec: Section; next: number } {
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let isNew = false;
  let isDeleted = false;
  const hunks: Hunk[] = [];
  let j = i;
  let inHeader = true;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) {
      return { sec: finishSection(pairOld, pairNew, renameOld, renameNew, git, isNew, isDeleted, hunks), next: j };
    }
    if (l.startsWith('--- ')) {
      const next = lines[j + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (!inHeader) return { sec: finishSection(pairOld, pairNew, renameOld, renameNew, git, isNew, isDeleted, hunks), next: j };
        if (pairOld === undefined) {
          pairOld = diffPath(l);
          pairNew = diffPath(next);
        }
        j += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${j + 2}`);
      j++;
      continue;
    }
    if (inHeader && l.startsWith('rename from ')) {
      renameOld = l.slice('rename from '.length).trim();
      j++;
      continue;
    }
    if (inHeader && l.startsWith('rename to ')) {
      renameNew = l.slice('rename to '.length).trim();
      j++;
      continue;
    }
    if (inHeader && l.startsWith('new file mode')) {
      isNew = true;
      j++;
      continue;
    }
    if (inHeader && l.startsWith('deleted file mode')) {
      isDeleted = true;
      j++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkA(l);
      if (a === null) throw new Exit2(`error: parse ${j + 1}`);
      const { hunk, next } = readHunkBody(lines, j + 1);
      hunk.a = a;
      hunks.push(hunk);
      inHeader = false;
      j = next;
      continue;
    }
    j++;
  }
  return { sec: finishSection(pairOld, pairNew, renameOld, renameNew, git, isNew, isDeleted, hunks), next: j };
}

/** Decide a section's paths and kind from its header: the `---`/`+++` pair names them, else `rename from`/`rename to`, else the `diff --git` paths. */
function finishSection(
  pairOld: string | null | undefined,
  pairNew: string | null | undefined,
  renameOld: string | undefined,
  renameNew: string | undefined,
  git: [string, string] | null,
  isNew: boolean,
  isDeleted: boolean,
  hunks: Hunk[],
): Section {
  const oldPath = pairOld !== undefined ? pairOld : renameOld !== undefined ? renameOld : git !== null ? git[0] : null;
  const newPath = pairNew !== undefined ? pairNew : renameNew !== undefined ? renameNew : git !== null ? git[1] : null;
  let kind: Section['kind'];
  if (oldPath === null && newPath === null) kind = 'noop';
  else if (oldPath === null || isNew) kind = 'create';
  else if (newPath === null || isDeleted) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return { oldPath, newPath, kind, hunks };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const git = gitPaths(l);
      if (git === null) throw new Exit2(`error: parse ${i + 1}`);
      const { sec, next } = parseSection(lines, i + 1, git);
      edits.push(unifiedSectionEdit(sec, strict));
      i = next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const { sec, next } = parseSection(lines, i, null);
      edits.push(unifiedSectionEdit(sec, strict));
      i = next;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = splitFile(cur);
    const found = firstTier(fs.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    const start = found.pos[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildReplacement(fs.lines, start, oldLines, n, found.tier);
    const lines = [...fs.lines.slice(0, start), ...repl, ...fs.lines.slice(start + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: fs.br, final: fs.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

/** One V4A chunk: its anchor (null: none), whether `*** End of File` ended it, and its body. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function vChunkOld(c: VChunk): string[] {
  return c.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
}

function vChunkNew(c: VChunk): NewLine[] {
  const out: NewLine[] = [];
  let oIdx = 0;
  for (const b of c.body) {
    if (b.kind === ' ') {
      out.push({ text: b.text, ctx: true, oIdx });
      oIdx++;
    } else if (b.kind === '-') {
      oIdx++;
    } else if (b.kind === '+') {
      out.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return out;
}

/** The first line at or after `from` equal to a single-line anchor at the first tier where one is, or null. */
function anchorAt(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fs = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = anchorAt(fs.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = vChunkOld(ch);
      const n = vChunkNew(ch);
      if (o.length === 0) {
        const at = ch.eof ? fs.lines.length : cursor;
        const ins = buildReplacement(fs.lines, at, [], n, 0);
        fs = { lines: [...fs.lines.slice(0, at), ...ins, ...fs.lines.slice(at)], br: fs.br, final: fs.final };
        cursor = at + ins.length;
      } else {
        const found = firstTier(fs.lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let start = found.pos[0]!;
        if (ch.eof) {
          const ok = found.pos.filter((p) => p + o.length === fs.lines.length);
          if (ok.length === 0) throw new Fail('no-match', path);
          start = ok[0]!;
        }
        const repl = buildReplacement(fs.lines, start, o, n, found.tier);
        fs = { lines: [...fs.lines.slice(0, start), ...repl, ...fs.lines.slice(start + o.length)], br: fs.br, final: fs.final };
        cursor = start + repl.length;
      }
    }
    const text = joinFile(fs);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const body: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        body.push({ text: l, num: i + 1 });
        i++;
      }
      while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.num}`);
      }
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(p));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      while (i < last && blank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          pushCur();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          pushCur();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i++;
          continue;
        }
        if (blank(l)) {
          if (cur !== null && l !== '' && l[0] !== ' ') throw new Exit2(`error: parse ${i + 1}`);
          if (cur !== null) cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: ' ', text: l.slice(1) });
          i++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushCur();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Run (SPEC.md sections 1, 2 and 10)                                 */
/* ------------------------------------------------------------------ */

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowList: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && nowNew !== undefined) {
      rowList.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
