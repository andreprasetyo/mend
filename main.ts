// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const movePairs: [string, string][] = [];

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

// --- Section 3 & 5 & 6 Helpers ---

function cleanLine(l: string, tier: number): string {
  if (tier === 0) return l;
  if (tier === 1) return l.replace(/[ \t]+$/, '');
  if (tier === 2) return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return l;
}

function findMatches(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  if (O.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    const cleanedO = O.map((l) => cleanLine(l, tier));
    const cleanedFile = fileLines.map((l) => cleanLine(l, tier));

    for (let i = 0; i <= cleanedFile.length - cleanedO.length; i++) {
      let match = true;
      for (let j = 0; j < cleanedO.length; j++) {
        if (cleanedFile[i + j] !== cleanedO[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        positions.push(i);
      }
    }
    if (positions.length > 0) {
      return { tier, positions };
    }
  }
  return null;
}

function parseFileText(text: string): { lines: string[]; breakStr: string; finalBreak: boolean } {
  if (text === '') {
    return { lines: [], breakStr: '\n', finalBreak: false };
  }
  const firstLf = text.indexOf('\n');
  const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
  const breakStr = crlf ? '\r\n' : '\n';
  const finalBreak = text.endsWith(breakStr);
  let content = text;
  if (finalBreak) {
    content = content.slice(0, -breakStr.length);
  }
  const lines = content === '' ? [] : content.split(breakStr);
  return { lines, breakStr, finalBreak };
}

function serializeFile(lines: string[], breakStr: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(breakStr) + (finalBreak ? breakStr : '');
}

function parseDiffPath(rawPath: string): string {
  const p = rawPath.split('\t')[0]!.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function getLeadingWhitespace(s: string): string {
  const match = s.match(/^[ \t]+/);
  return match ? match[0] : '';
}

interface UnifiedSection {
  startLine: number;
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  hunks: {
    headerLine: number;
    A: number;
    C: number;
    body: { type: ' ' | '-' | '+' | '\\'; text: string; lineNo: number }[];
  }[];
}

function unifiedEdits(text: string, patchLinesArr: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let currentSection: UnifiedSection | null = null;

  const closeSection = () => {
    if (currentSection) {
      sections.push(currentSection);
      currentSection = null;
    }
  };

  let i = 0;
  while (i < patchLinesArr.length) {
    const line = patchLinesArr[i]!;
    const lineNo = i + 1;

    if (line.startsWith('diff --git ')) {
      closeSection();
      const rest = line.slice(11);
      const bIdx = rest.lastIndexOf(' b/');
      if (bIdx === -1 || !rest.startsWith('a/')) {
        throw new Exit2(`error: parse ${lineNo}`);
      }
      const aPart = rest.slice(2, bIdx);
      const bPart = rest.slice(bIdx + 3);
      const oldP = parseDiffPath(aPart);
      const newP = parseDiffPath(bPart);
      currentSection = {
        startLine: lineNo,
        oldPath: oldP,
        newPath: newP,
        isNew: false,
        isDeleted: false,
        renameFrom: null,
        renameTo: null,
        hunks: [],
      };
      i++;
      continue;
    }

    if (line.startsWith('--- ')) {
      const nextLine = patchLinesArr[i + 1];
      const nextLineNo = i + 2;
      if (nextLine === undefined || !nextLine.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${nextLineNo}`);
      }
      if (currentSection && currentSection.hunks.length > 0) {
        sections.push(currentSection);
        currentSection = null;
      }
      if (!currentSection) {
        currentSection = {
          startLine: lineNo,
          oldPath: null,
          newPath: null,
          isNew: false,
          isDeleted: false,
          renameFrom: null,
          renameTo: null,
          hunks: [],
        };
      }
      currentSection.oldPath = parseDiffPath(line.slice(4));
      currentSection.newPath = parseDiffPath(nextLine.slice(4));
      i += 2;
      continue;
    }

    if (currentSection && currentSection.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        currentSection.renameFrom = parseDiffPath(line.slice(12));
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        currentSection.renameTo = parseDiffPath(line.slice(10));
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        currentSection.isNew = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        currentSection.isDeleted = true;
        i++;
        continue;
      }
      if (
        line.startsWith('index ') ||
        line.startsWith('old mode ') ||
        line.startsWith('new mode ') ||
        line.startsWith('similarity index ') ||
        line.startsWith('dissimilarity index ') ||
        line.startsWith('Index:') ||
        line.trim() === ''
      ) {
        i++;
        continue;
      }
    }

    if (line.startsWith('@@')) {
      if (!currentSection) {
        throw new Exit2(`error: parse ${lineNo}`);
      }
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (!match) {
        throw new Exit2(`error: parse ${lineNo}`);
      }
      const A = parseInt(match[1]!, 10);
      const C = parseInt(match[2]!, 10);

      i++;
      const body: { type: ' ' | '-' | '+' | '\\'; text: string; lineNo: number }[] = [];
      while (i < patchLinesArr.length) {
        const bLine = patchLinesArr[i]!;
        const bLineNo = i + 1;
        if (bLine.startsWith('diff --git ')) break;
        if (bLine.startsWith('--- ') && i + 1 < patchLinesArr.length && patchLinesArr[i + 1]!.startsWith('+++ ')) break;
        if (bLine.startsWith('@@')) break;

        if (bLine === '' || bLine.startsWith(' ') || bLine.startsWith('-') || bLine.startsWith('+') || bLine.startsWith('\\')) {
          let type: ' ' | '-' | '+' | '\\' = ' ';
          let text = '';
          if (bLine === '') {
            type = ' ';
            text = '';
          } else if (bLine.startsWith(' ')) {
            type = ' ';
            text = bLine.slice(1);
          } else if (bLine.startsWith('-')) {
            type = '-';
            text = bLine.slice(1);
          } else if (bLine.startsWith('+')) {
            type = '+';
            text = bLine.slice(1);
          } else if (bLine.startsWith('\\')) {
            type = '\\';
            text = bLine;
          }
          body.push({ type, text, lineNo: bLineNo });
          i++;
        } else {
          break;
        }
      }

      while (body.length > 0 && body[body.length - 1]!.type === ' ' && body[body.length - 1]!.text === '') {
        body.pop();
      }

      currentSection.hunks.push({
        headerLine: lineNo,
        A,
        C,
        body,
      });
      continue;
    }

    i++;
  }
  closeSection();

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const section of sections) {
    const oldP = section.oldPath === '/dev/null' ? null : section.oldPath ?? section.renameFrom;
    const newP = section.newPath === '/dev/null' ? null : section.newPath ?? section.renameTo;

    const isNew = section.isNew || section.oldPath === '/dev/null';
    const isDeleted = section.isDeleted || section.newPath === '/dev/null';
    const isMove = oldP !== null && newP !== null && oldP !== newP && !isNew && !isDeleted;
    const isCreation = isNew || (oldP === null && newP !== null);
    const isDeletion = isDeleted || (oldP !== null && newP === null);
    const isChange = oldP !== null && newP !== null && oldP === newP && !isNew && !isDeleted;

    const targetPath = isCreation ? newP! : isDeletion ? oldP! : isMove ? oldP! : oldP!;

    edits.push((tree: Tree) => {
      if (oldP !== null && oldP !== '/dev/null') {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
      }
      if (newP !== null && newP !== '/dev/null') {
        if (!safe(newP)) throw new Fail('unsafe', newP);
      }

      if (isCreation) {
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const N: string[] = [];
        let trailingNoNewline = false;
        for (const hunk of section.hunks) {
          for (let bIdx = 0; bIdx < hunk.body.length; bIdx++) {
            const b = hunk.body[bIdx]!;
            if (b.type === '\\') {
              if (bIdx > 0 && hunk.body[bIdx - 1]!.type === '+') {
                trailingNoNewline = true;
              }
              continue;
            }
            if (b.type === '+') {
              N.push(b.text);
            }
          }
        }
        const finalBreak = !trailingNoNewline;
        const createdText = serializeFile(N, '\n', finalBreak);
        tree.now.set(newP!, createdText);
      } else if (isDeletion) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
      } else if (isMove) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);

        const originalText = tree.get(oldP!)!;
        let { lines: workLines, breakStr, finalBreak } = parseFileText(originalText);
        let d = 0;

        for (const hunk of section.hunks) {
          const O: string[] = [];
          const N: string[] = [];
          let lastContextOrPlusIndex = -1;
          let trailingNoNewline = false;

          for (let idx = 0; idx < hunk.body.length; idx++) {
            const b = hunk.body[idx]!;
            if (b.type === '\\') {
              if (idx > 0 && (hunk.body[idx - 1]!.type === ' ' || hunk.body[idx - 1]!.type === '+' || hunk.body[idx - 1]!.type === '-')) {
                if (idx - 1 === lastContextOrPlusIndex) {
                  trailingNoNewline = true;
                }
              }
              continue;
            }
            if (b.type === ' ' || b.type === '-') {
              O.push(b.text);
            }
            if (b.type === ' ' || b.type === '+') {
              N.push(b.text);
              lastContextOrPlusIndex = idx;
            }
          }

          let matchTier = 0;
          let matchPos = 0;
          if (O.length > 0) {
            const res = findMatches(workLines, O, strict);
            if (!res) {
              throw new Fail('no-match', oldP!);
            }
            matchTier = res.tier;
            const targetA = hunk.A - 1 + d;
            let bestPos = res.positions[0]!;
            let bestDist = Math.abs(bestPos - targetA);
            for (let pIdx = 1; pIdx < res.positions.length; pIdx++) {
              const pos = res.positions[pIdx]!;
              const dist = Math.abs(pos - targetA);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = pos;
              }
            }
            matchPos = bestPos;
          } else {
            matchPos = Math.min(hunk.A + d, workLines.length);
          }

          const replacedLines: string[] = [];
          let F = '';
          let P = '';
          if (matchTier === 2 && O.length > 0 && workLines.length > matchPos) {
            F = getLeadingWhitespace(workLines[matchPos]!);
            P = getLeadingWhitespace(O[0]!);
          }

          let fileOffset = 0;
          for (const b of hunk.body) {
            if (b.type === ' ') {
              if (O.length > 0) {
                replacedLines.push(workLines[matchPos + fileOffset]!);
                fileOffset++;
              } else {
                replacedLines.push(b.text);
              }
            } else if (b.type === '+') {
              let lineText = b.text;
              if (matchTier === 2 && lineText !== '' && lineText.trim() !== '' && lineText.startsWith(P)) {
                lineText = F + lineText.slice(P.length);
              }
              replacedLines.push(lineText);
            } else if (b.type === '-') {
              fileOffset++;
            }
          }

          const runsToEnd = (O.length > 0 && matchPos + O.length === workLines.length) || (O.length === 0 && matchPos === workLines.length);

          workLines.splice(matchPos, O.length, ...replacedLines);

          if (runsToEnd) {
            finalBreak = !trailingNoNewline;
          }

          d += N.length - O.length;
        }

        const resultText = serializeFile(workLines, breakStr, finalBreak);
        tree.now.set(oldP!, null);
        tree.now.set(newP!, resultText);
        movePairs.push([oldP!, newP!]);
      } else {
        // Change
        if (tree.get(targetPath) === null) throw new Fail('missing', targetPath);

        const originalText = tree.get(targetPath)!;
        let { lines: workLines, breakStr, finalBreak } = parseFileText(originalText);
        let d = 0;

        for (const hunk of section.hunks) {
          const O: string[] = [];
          const N: string[] = [];
          let lastContextOrPlusIndex = -1;
          let trailingNoNewline = false;

          for (let idx = 0; idx < hunk.body.length; idx++) {
            const b = hunk.body[idx]!;
            if (b.type === '\\') {
              if (idx > 0 && (hunk.body[idx - 1]!.type === ' ' || hunk.body[idx - 1]!.type === '+' || hunk.body[idx - 1]!.type === '-')) {
                if (idx - 1 === lastContextOrPlusIndex) {
                  trailingNoNewline = true;
                }
              }
              continue;
            }
            if (b.type === ' ' || b.type === '-') {
              O.push(b.text);
            }
            if (b.type === ' ' || b.type === '+') {
              N.push(b.text);
              lastContextOrPlusIndex = idx;
            }
          }

          let matchTier = 0;
          let matchPos = 0;
          if (O.length > 0) {
            const res = findMatches(workLines, O, strict);
            if (!res) {
              throw new Fail('no-match', targetPath);
            }
            matchTier = res.tier;
            const targetA = hunk.A - 1 + d;
            let bestPos = res.positions[0]!;
            let bestDist = Math.abs(bestPos - targetA);
            for (let pIdx = 1; pIdx < res.positions.length; pIdx++) {
              const pos = res.positions[pIdx]!;
              const dist = Math.abs(pos - targetA);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = pos;
              }
            }
            matchPos = bestPos;
          } else {
            matchPos = Math.min(hunk.A + d, workLines.length);
          }

          const replacedLines: string[] = [];
          let F = '';
          let P = '';
          if (matchTier === 2 && O.length > 0 && workLines.length > matchPos) {
            F = getLeadingWhitespace(workLines[matchPos]!);
            P = getLeadingWhitespace(O[0]!);
          }

          let fileOffset = 0;
          for (const b of hunk.body) {
            if (b.type === ' ') {
              if (O.length > 0) {
                replacedLines.push(workLines[matchPos + fileOffset]!);
                fileOffset++;
              } else {
                replacedLines.push(b.text);
              }
            } else if (b.type === '+') {
              let lineText = b.text;
              if (matchTier === 2 && lineText !== '' && lineText.trim() !== '' && lineText.startsWith(P)) {
                lineText = F + lineText.slice(P.length);
              }
              replacedLines.push(lineText);
            } else if (b.type === '-') {
              fileOffset++;
            }
          }

          const runsToEnd = (O.length > 0 && matchPos + O.length === workLines.length) || (O.length === 0 && matchPos === workLines.length);

          workLines.splice(matchPos, O.length, ...replacedLines);

          if (runsToEnd) {
            finalBreak = !trailingNoNewline;
          }

          d += N.length - O.length;
        }

        const resultText = serializeFile(workLines, breakStr, finalBreak);
        tree.now.set(targetPath, resultText);
      }
    });
  }

  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevBlockEndIdx = 0;
  let firstBlock = true;
  let lastPath: string | null = null;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmedMarker = line.replace(/[ \t]+$/, '');
    if (trimmedMarker === '<<<<<<< SEARCH') {
      const searchLineNo = i + 1;
      let path: string | null = null;
      for (let pIdx = i - 1; pIdx >= prevBlockEndIdx; pIdx--) {
        const pLine = lines[pIdx]!;
        if (blank(pLine)) continue;
        const trimmedP = pLine.trim();
        if (trimmedP.startsWith('```')) continue;
        path = trimmedP;
        break;
      }
      if (path === null) {
        if (firstBlock) {
          throw new Exit2(`error: parse ${searchLineNo}`);
        }
        path = lastPath;
      }
      lastPath = path;
      firstBlock = false;

      let eqIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.replace(/[ \t]+$/, '') === '=======') {
          eqIdx = j;
          break;
        }
      }
      if (eqIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }

      let endIdx = -1;
      for (let j = eqIdx + 1; j < lines.length; j++) {
        if (lines[j]!.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
          endIdx = j;
          break;
        }
      }
      if (endIdx === -1) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }

      const O = lines.slice(i + 1, eqIdx);
      const N = lines.slice(eqIdx + 1, endIdx);

      const targetPath = path!;

      edits.push((tree: Tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (O.length === 0) {
          if (tree.get(targetPath) !== null) throw new Fail('exists', targetPath);
          const createdText = serializeFile(N, '\n', true);
          tree.now.set(targetPath, createdText);
        } else {
          if (tree.get(targetPath) === null) throw new Fail('missing', targetPath);
          const originalText = tree.get(targetPath)!;
          const { lines: fileLines, breakStr, finalBreak } = parseFileText(originalText);
          const matchRes = findMatches(fileLines, O, strict);
          if (matchRes === null) throw new Fail('no-match', targetPath);
          if (matchRes.positions.length > 1) throw new Fail('ambiguous', targetPath);
          const pos = matchRes.positions[0]!;
          const tier = matchRes.tier;

          let F = '';
          let P = '';
          if (tier === 2 && O.length > 0 && fileLines.length > pos) {
            F = getLeadingWhitespace(fileLines[pos]!);
            P = getLeadingWhitespace(O[0]!);
          }

          const processedN = N.map((lineText) => {
            if (tier === 2 && lineText !== '' && lineText.trim() !== '' && lineText.startsWith(P)) {
              return F + lineText.slice(P.length);
            }
            return lineText;
          });

          fileLines.splice(pos, O.length, ...processedN);
          const resultText = serializeFile(fileLines, breakStr, finalBreak);
          tree.now.set(targetPath, resultText);
        }
      });

      prevBlockEndIdx = endIdx + 1;
      i = endIdx + 1;
    } else {
      i++;
    }
  }

  return edits;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank < 0 ? 1 : firstNonBlank + 1}`);
  }

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      lastNonBlank = i;
      break;
    }
  }
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  type V4ASection =
    | { type: 'add'; path: string; fileLines: string[]; headerLine: number }
    | { type: 'delete'; path: string; headerLine: number }
    | { type: 'update'; sourcePath: string; movePath: string | null; chunks: V4AChunk[]; headerLine: number };

  interface V4AChunk {
    anchor: string | null;
    endAnchored: boolean;
    body: { type: ' ' | '-' | '+'; text: string; lineNo: number }[];
    headerLine: number;
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;
  const endIdx = lastNonBlank;

  while (i < endIdx) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (blank(line)) {
      i++;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('*** Add File: ')) {
      const path = trimmed.slice(14).trim();
      const headerLine = lineNo;
      i++;
      const bodyLines: string[] = [];
      while (i < endIdx) {
        const bLine = lines[i]!;
        const bLineNo = i + 1;
        if (blank(bLine)) {
          let nextNonBlankIdx = -1;
          for (let k = i; k < endIdx; k++) {
            if (!blank(lines[k]!)) {
              nextNonBlankIdx = k;
              break;
            }
          }
          if (nextNonBlankIdx === -1 || lines[nextNonBlankIdx]!.trim().startsWith('*** ')) {
            break;
          }
          bodyLines.push('');
          i++;
          continue;
        }

        const bTrimmed = bLine.trim();
        if (bTrimmed.startsWith('*** Add File: ') || bTrimmed.startsWith('*** Delete File: ') || bTrimmed.startsWith('*** Update File: ')) {
          break;
        }

        if (bLine.startsWith('+')) {
          bodyLines.push(bLine.slice(1));
          i++;
        } else {
          throw new Exit2(`error: parse ${bLineNo}`);
        }
      }
      sections.push({ type: 'add', path, fileLines: bodyLines, headerLine });
      continue;
    }

    if (trimmed.startsWith('*** Delete File: ')) {
      const path = trimmed.slice(17).trim();
      const headerLine = lineNo;
      i++;
      while (i < endIdx) {
        const bLine = lines[i]!;
        const bLineNo = i + 1;
        if (blank(bLine)) {
          let nextNonBlankIdx = -1;
          for (let k = i; k < endIdx; k++) {
            if (!blank(lines[k]!)) {
              nextNonBlankIdx = k;
              break;
            }
          }
          if (nextNonBlankIdx === -1 || lines[nextNonBlankIdx]!.trim().startsWith('*** ')) {
            break;
          }
          throw new Exit2(`error: parse ${bLineNo}`);
        }
        const bTrimmed = bLine.trim();
        if (bTrimmed.startsWith('*** Add File: ') || bTrimmed.startsWith('*** Delete File: ') || bTrimmed.startsWith('*** Update File: ')) {
          break;
        }
        throw new Exit2(`error: parse ${bLineNo}`);
      }
      sections.push({ type: 'delete', path, headerLine });
      continue;
    }

    if (trimmed.startsWith('*** Update File: ')) {
      const sourcePath = trimmed.slice(17).trim();
      const headerLine = lineNo;
      i++;

      let movePath: string | null = null;
      const chunks: V4AChunk[] = [];
      let currentChunk: V4AChunk | null = null;

      while (i < endIdx) {
        const bLine = lines[i]!;
        const bLineNo = i + 1;
        if (blank(bLine)) {
          let nextNonBlankIdx = -1;
          for (let k = i; k < endIdx; k++) {
            if (!blank(lines[k]!)) {
              nextNonBlankIdx = k;
              break;
            }
          }
          if (nextNonBlankIdx === -1 || lines[nextNonBlankIdx]!.trim().startsWith('*** ')) {
            break;
          }
          if (!currentChunk) {
            i++;
            continue;
          }
          currentChunk.body.push({ type: ' ', text: '', lineNo: bLineNo });
          i++;
          continue;
        }

        const bTrimmed = bLine.trim();
        if (bTrimmed.startsWith('*** Add File: ') || bTrimmed.startsWith('*** Delete File: ') || bTrimmed.startsWith('*** Update File: ')) {
          break;
        }

        if (bTrimmed.startsWith('*** Move to: ')) {
          if (movePath !== null || chunks.length > 0 || currentChunk !== null) {
            throw new Exit2(`error: parse ${bLineNo}`);
          }
          movePath = bTrimmed.slice(13).trim();
          i++;
          continue;
        }

        if (bTrimmed.startsWith('@@')) {
          if (currentChunk) {
            chunks.push(currentChunk);
            currentChunk = null;
          }
          const anchor = bTrimmed.slice(2).trim();
          currentChunk = {
            anchor: anchor === '' ? null : anchor,
            endAnchored: false,
            body: [],
            headerLine: bLineNo,
          };
          i++;
          continue;
        }

        if (bTrimmed === '*** End of File') {
          if (!currentChunk) {
            throw new Exit2(`error: parse ${bLineNo}`);
          }
          currentChunk.endAnchored = true;
          chunks.push(currentChunk);
          currentChunk = null;
          i++;
          continue;
        }

        if (bLine.startsWith(' ') || bLine.startsWith('-') || bLine.startsWith('+')) {
          let type: ' ' | '-' | '+' = ' ';
          let text = '';
          if (bLine.startsWith(' ')) {
            type = ' ';
            text = bLine.slice(1);
          } else if (bLine.startsWith('-')) {
            type = '-';
            text = bLine.slice(1);
          } else if (bLine.startsWith('+')) {
            type = '+';
            text = bLine.slice(1);
          }

          if (!currentChunk) {
            currentChunk = {
              anchor: null,
              endAnchored: false,
              body: [],
              headerLine: bLineNo,
            };
          }
          currentChunk.body.push({ type, text, lineNo: bLineNo });
          i++;
          continue;
        }

        throw new Exit2(`error: parse ${bLineNo}`);
      }

      if (currentChunk) {
        chunks.push(currentChunk);
      }

      for (const ch of chunks) {
        while (ch.body.length > 0 && ch.body[ch.body.length - 1]!.type === ' ' && ch.body[ch.body.length - 1]!.text === '') {
          ch.body.pop();
        }
      }

      if (chunks.length === 0 && movePath === null) {
        throw new Exit2(`error: parse ${headerLine}`);
      }

      sections.push({ type: 'update', sourcePath, movePath, chunks, headerLine });
      continue;
    }

    throw new Exit2(`error: parse ${lineNo}`);
  }

  if (sections.length === 0) {
    throw new Exit2(`error: parse 1`);
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.type === 'add') {
      edits.push((tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        const text = serializeFile(sec.fileLines, '\n', true);
        tree.now.set(sec.path, text);
      });
    } else if (sec.type === 'delete') {
      edits.push((tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      });
    } else if (sec.type === 'update') {
      edits.push((tree: Tree) => {
        if (!safe(sec.sourcePath)) throw new Fail('unsafe', sec.sourcePath);
        if (sec.movePath !== null) {
          if (!safe(sec.movePath)) throw new Fail('unsafe', sec.movePath);
        }
        if (tree.get(sec.sourcePath) === null) throw new Fail('missing', sec.sourcePath);
        if (sec.movePath !== null && tree.get(sec.movePath) !== null) {
          throw new Fail('exists', sec.movePath);
        }

        const origText = tree.get(sec.sourcePath)!;
        let { lines: workLines, breakStr, finalBreak } = parseFileText(origText);
        let cursor = 0;

        for (const chunk of sec.chunks) {
          let startIndex = cursor;
          let matchTier = 0;

          if (chunk.anchor !== null) {
            let foundAnchor = false;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier; t++) {
              const cleanedAnchor = cleanLine(chunk.anchor, t);
              for (let idx = cursor; idx < workLines.length; idx++) {
                if (cleanLine(workLines[idx]!, t) === cleanedAnchor) {
                  startIndex = idx;
                  matchTier = t;
                  foundAnchor = true;
                  break;
                }
              }
              if (foundAnchor) break;
            }
            if (!foundAnchor) {
              throw new Fail('no-match', sec.sourcePath);
            }
            cursor = startIndex;
          }

          const O: string[] = [];
          const N: string[] = [];
          for (const b of chunk.body) {
            if (b.type === ' ' || b.type === '-') {
              O.push(b.text);
            }
            if (b.type === ' ' || b.type === '+') {
              N.push(b.text);
            }
          }

          let matchPos = startIndex;
          if (O.length > 0) {
            const sliceLines = workLines.slice(startIndex);
            const res = findMatches(sliceLines, O, strict);
            if (!res) {
              throw new Fail('no-match', sec.sourcePath);
            }
            matchTier = res.tier;
            let chosenPos = -1;
            for (const posInSlice of res.positions) {
              const absPos = posInSlice + startIndex;
              if (chunk.endAnchored) {
                if (absPos + O.length === workLines.length) {
                  chosenPos = absPos;
                  break;
                }
              } else {
                chosenPos = absPos;
                break;
              }
            }
            if (chosenPos === -1) {
              throw new Fail('no-match', sec.sourcePath);
            }
            matchPos = chosenPos;
          } else {
            if (chunk.endAnchored) {
              matchPos = workLines.length;
            } else {
              matchPos = cursor;
            }
          }

          let F = '';
          let P = '';
          if (matchTier === 2 && O.length > 0 && workLines.length > matchPos) {
            F = getLeadingWhitespace(workLines[matchPos]!);
            P = getLeadingWhitespace(O[0]!);
          }

          const replacedLines: string[] = [];
          let fileOffset = 0;
          for (const b of chunk.body) {
            if (b.type === ' ') {
              if (O.length > 0) {
                replacedLines.push(workLines[matchPos + fileOffset]!);
                fileOffset++;
              } else {
                replacedLines.push(b.text);
              }
            } else if (b.type === '+') {
              let lineText = b.text;
              if (matchTier === 2 && lineText !== '' && lineText.trim() !== '' && lineText.startsWith(P)) {
                lineText = F + lineText.slice(P.length);
              }
              replacedLines.push(lineText);
            } else if (b.type === '-') {
              fileOffset++;
            }
          }

          workLines.splice(matchPos, O.length, ...replacedLines);
          cursor = matchPos + replacedLines.length;
        }

        const resultText = serializeFile(workLines, breakStr, finalBreak);
        if (sec.movePath !== null) {
          tree.now.set(sec.sourcePath, null);
          tree.now.set(sec.movePath, resultText);
          movePairs.push([sec.sourcePath, sec.movePath]);
        } else {
          tree.now.set(sec.sourcePath, resultText);
        }
      });
    }
  }

  return edits;
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
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(text, lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  movePairs.length = 0;
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
  const rowMap = new Map<string, { sortKey: string; text: string; kind: string; path: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rowMap.set(p, {
      sortKey: p,
      text: `${kind} ${p}`,
      kind,
      path: p,
    });
  }
  for (const [o, n] of movePairs) {
    const rowO = rowMap.get(o);
    const rowN = rowMap.get(n);
    if (rowO && rowN && rowO.kind === 'D' && rowN.kind === 'A') {
      rowMap.delete(o);
      rowMap.delete(n);
      rowMap.set(n, {
        sortKey: n,
        text: `R ${o} -> ${n}`,
        kind: 'R',
        path: n,
      });
    }
  }
  const rows = [...rowMap.values()].sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rowTexts = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rowTexts, `ok: ${rowTexts.length} ${rowTexts.length === 1 ? 'file' : 'files'}`] };
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
