// Extra checks for sentences of SPEC.md the public practice set does not show.
// Run: node tests/extra.mjs   (from the repository root)
// Each case runs `node main.ts` once in a fresh directory and compares exit code, exact
// stdout and the exact resulting files. Exits non-zero when any case fails.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-extra-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10_000,
    });
    const gotFiles = readTree(dir);
    const why = [];
    if (r.status !== c.expect.exit) why.push(`exit ${r.status}, expected ${c.expect.exit}`);
    if ((r.stdout ?? '') !== c.expect.stdout) why.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
    const want = { ...c.files };
    for (const [p, v] of Object.entries(c.expect.changes)) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    for (const p of new Set([...Object.keys(want), ...Object.keys(gotFiles)])) {
      if (want[p] === undefined) why.push(`${p} should not exist`);
      else if (gotFiles[p] === undefined) why.push(`${p} is missing`);
      else if (gotFiles[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(gotFiles[p])}`);
    }
    return why;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: 'u-tier2-reindent',
    files: {
      'f.txt': 'def foo():\n  x = 1\n  y = 2\n  return x\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -2,3 +2,3 @@\n     x = 1\n-    y = 2\n+    a = 10\n     return x\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def foo():\n  x = 1\n  a = 10\n  return x\n' } },
  },
  {
    name: 'u-drift-two-hunks',
    files: {
      'f.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,4 @@\n one\n+extra1\n+extra2\n two\n@@ -5,2 +7,2 @@\n five\n-six\n+SIX\n seven\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'one\nextra1\nextra2\ntwo\nthree\nfour\nfive\nSIX\nseven\neight\n' } },
  },
  {
    name: 'u-insert-eof-with-break',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\n' } },
  },
  {
    name: 'u-insert-eof-no-break',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n\\ No newline at end of file\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc' } },
  },
  {
    name: 'u-insert-mid',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+x\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nx\nb\n' } },
  },
  {
    name: 'u-create-no-break',
    files: { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'hello\nworld' } },
  },
  {
    name: 'u-create-empty',
    files: { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,0 @@\n' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': '' } },
  },
  {
    name: 'u-delete-hunks-not-read',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '--- a/f.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'D f.txt\nok: 1 file\n', changes: { 'f.txt': null } },
  },
  {
    name: 'u-delete-missing',
    files: { 'p.patch': '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'u-move-to-existing',
    files: {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'p.patch': 'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'u-move-from-missing',
    files: {
      'b.txt': 'b\n',
      'p.patch': '--- a/missing.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: missing missing.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'u-unsafe-dotdot',
    files: { 'p.patch': '--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'u-unsafe-absolute',
    files: { 'p.patch': '--- /abs.txt\n+++ /abs.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: unsafe /abs.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'u-rename-beats-git-paths',
    files: {
      'real-old.txt': 'a\n',
      'git-old.txt': 'g\n',
      'p.patch': 'diff --git a/git-old.txt b/git-new.txt\nsimilarity index 90%\nrename from real-old.txt\nrename to real-new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'R real-old.txt -> real-new.txt\nok: 1 file\n', changes: { 'real-old.txt': null, 'real-new.txt': 'b\n' } },
  },
  {
    name: 'u-hunk-before-section',
    files: { 'p.patch': '@@ -1,1 +1,1 @@\n-a\n+b\n' },
    argv: ['--format=unified', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
  },
  {
    name: 'u-delete-last-line-no-break',
    files: {
      'f.txt': 'a\nb',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\n' } },
  },
  {
    name: 'u-replace-last-line-no-break',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nB' } },
  },
  {
    name: 's-tier0-beats-tier1',
    files: {
      'f.txt': 'x = 1\nx = 1 \ny = 2\n',
      'p.patch': 'f.txt\n<<<<<<< SEARCH\nx = 1\n=======\nx = 9\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x = 9\nx = 1 \ny = 2\n' } },
  },
  {
    name: 's-ambiguous-tier1',
    files: {
      'f.txt': 'x = 1 \nx = 1  \ny = 2\n',
      'p.patch': 'f.txt\n<<<<<<< SEARCH\nx = 1\n=======\nx = 9\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 's-tier1-unique',
    files: {
      'f.txt': 'x = 1 \ny = 2\n',
      'p.patch': 'f.txt\n<<<<<<< SEARCH\nx = 1\n=======\nx = 9\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x = 9\ny = 2\n' } },
  },
  {
    name: 's-tier2-reindent',
    files: {
      'f.txt': '    x = 1\n    y = 2\n',
      'p.patch': 'f.txt\n<<<<<<< SEARCH\nx = 1\n=======\nx = 9\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '    x = 9\n    y = 2\n' } },
  },
  {
    name: 's-path-inherited',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nB\n' } },
  },
  {
    name: 's-create',
    files: {
      'p.patch': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'hello\nworld\n' } },
  },
  {
    name: 's-fenced-path-above',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': 'f.txt\n```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nb\n' } },
  },
  {
    name: 'v-anchor-tier1',
    files: {
      'f.txt': 'def foo():\n    x = 1\n    return x\n',
      'p.patch': '*** Begin Patch\n*** Update File: f.txt\n@@ def foo(): \n     x = 1\n-    return x\n+    return x * 2\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def foo():\n    x = 1\n    return x * 2\n' } },
  },
  {
    name: 'v-eof-not-at-end',
    files: {
      'f.txt': 'a\nb\nc\nd\n',
      'p.patch': '*** Begin Patch\n*** Update File: f.txt\n@@\n b\n-c\n+C\n*** End of File\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'v-move-only',
    files: {
      'a.txt': 'a\nb\n',
      'p.patch': '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', changes: { 'a.txt': null, 'b.txt': 'a\nb\n' } },
  },
  {
    name: 'v-add-empty-middle-line',
    files: {
      'p.patch': '*** Begin Patch\n*** Add File: n.txt\n+line1\n\n+line3\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'line1\n\nline3\n' } },
  },
  {
    name: 'v-body-after-eof-parse',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '*** Begin Patch\n*** Update File: f.txt\n@@ anchor\n a\n*** End of File\n b\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: parse 6\n', changes: {} },
  },
  {
    name: 'v-anchor-missing',
    files: {
      'f.txt': 'a\nb\n',
      'p.patch': '*** Begin Patch\n*** Update File: f.txt\n@@ missing-anchor\n a\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'v-insert-at-cursor',
    files: {
      'f.txt': 'def foo():\n    x = 1\n',
      'p.patch': '*** Begin Patch\n*** Update File: f.txt\n@@ def foo():\n+    inserted = 1\n*** End Patch\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'def foo():\n    inserted = 1\n    x = 1\n' } },
  },
  {
    name: 'c-format-json-on-unified',
    files: { 'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n' },
    argv: ['--format=json', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
  },
  {
    name: 'c-format-unified-on-prose',
    files: { 'p.patch': 'just some prose\nnothing here\n' },
    argv: ['--format=unified', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: parse 1\n', changes: {} },
  },
  {
    name: 'c-check-no-write',
    files: {
      'f.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,4 @@\n one\n+extra1\n+extra2\n two\n@@ -5,2 +7,2 @@\n five\n-six\n+SIX\n seven\n',
    },
    argv: ['--check', 'p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: {} },
  },
  {
    name: 'c-usage-bad-format',
    files: { 'p.patch': 'x\n' },
    argv: ['--format=bogus', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
  },
  {
    name: 'c-usage-duplicate-check',
    files: { 'p.patch': 'x\n' },
    argv: ['--check', '--check', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
  },
  {
    name: 'c-usage-two-positionals',
    files: { 'p.patch': 'x\n' },
    argv: ['p.patch', 'other.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
  },
  {
    name: 'c-usage-unknown-flag',
    files: { 'p.patch': 'x\n' },
    argv: ['-x', 'p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: usage\n', changes: {} },
  },
  {
    name: 'c-empty-patch',
    files: { 'p.patch': '' },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: format\n', changes: {} },
  },
  {
    name: 'c-no-patch-file',
    files: {},
    argv: ['missing.patch'],
    stdin: null,
    expect: { exit: 2, stdout: 'error: no-patch\n', changes: {} },
  },
  {
    name: 'c-strict-tier2-fails',
    files: {
      'f.txt': 'def foo():\n  x = 1\n  y = 2\n  return x\n',
      'p.patch': '--- a/f.txt\n+++ b/f.txt\n@@ -2,3 +2,3 @@\n     x = 1\n-    y = 2\n+    a = 10\n     return x\n',
    },
    argv: ['--strict', 'p.patch'],
    stdin: null,
    expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} },
  },
  {
    name: 'r-two-moves-sorted',
    files: {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'p.patch': 'diff --git a/b.txt b/z.txt\nrename from b.txt\nrename to z.txt\n--- a/b.txt\n+++ b/z.txt\n@@ -1,1 +1,1 @@\n-b\n+B\n--- a/a.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'R a.txt -> m.txt\nR b.txt -> z.txt\nok: 2 files\n', changes: { 'a.txt': null, 'b.txt': null, 'm.txt': 'A\n', 'z.txt': 'B\n' } },
  },
  {
    name: 'r-move-plus-change-sorted',
    files: {
      'a.txt': 'a\n',
      'c.txt': 'c\n',
      'p.patch': '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-c\n+C\n',
    },
    argv: ['p.patch'],
    stdin: null,
    expect: { exit: 0, stdout: 'R a.txt -> b.txt\nM c.txt\nok: 2 files\n', changes: { 'a.txt': null, 'b.txt': 'A\n', 'c.txt': 'C\n' } },
  },
];

let failed = 0;
for (const c of cases) {
  const why = runCase(c);
  if (why.length === 0) {
    process.stdout.write(`ok ${c.name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  }
}
process.stdout.write(`${cases.length - failed} of ${cases.length} extra checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
