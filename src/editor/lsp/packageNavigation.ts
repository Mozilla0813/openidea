/**
 * Go to Declaration on a JVM package name: a package's declaration is its folder, so the
 * `a.b` of `package a.b;` or `import a.b.C;` selects that folder in the Project view, as in
 * IDEA. A library package has no folder in the project and keeps the server's answer.
 */
import type { EditorView } from "@codemirror/view";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { effectiveRoots, isJvmPackageRoot, type RootFolder } from "@/platform/languageSettings";
import { dirname, useProject } from "@/platform/project";
import { currentRoots, useProjectRoots } from "@/platform/projectRoots";
import { docOf } from "./lsp";

/** Languages whose package names map to folders of the same path. */
const JVM_LANGUAGES = new Set(["java", "kotlin", "scala", "groovy"]);

const PACKAGE = /^\s*package\s+([\w.]+)/;
const IMPORT = /^\s*import\s+(static\s+)?([\w.*]+)/;
const DECLARED_PACKAGE = /^\s*package\s+([\w.]+)/m;

/**
 * The package part of the `package` / `import` line at `col` (0-based within the line), up to
 * the segment under the caret: `a.b` for `a.b.C` with the caret on `b`. Null when the line is
 * neither, or the caret is on the imported class, its member or a `*`.
 */
export function packageNameAtLine(line: string, col: number): string | null {
  const decl = PACKAGE.exec(line);
  const imp = decl ? null : IMPORT.exec(line);
  const raw = decl?.[1] ?? imp?.[2];
  if (!raw) return null;
  // Scala's `import a.b.{C, D}` stops at the brace: the trailing dot ends the package, and the
  // group lists its members.
  const grouped = /\.$/.test(raw);
  const name = raw.replace(/\.+$/, "");
  const start = line.indexOf(name, (decl ?? imp)!.index);
  if (start < 0) return null;
  const segments = name.split(".");
  // A wildcard names its package; otherwise the class (and, for a static import, the member)
  // is not part of it.
  let count = segments.length;
  if (!grouped) {
    if (segments[count - 1] === "*") count -= 1;
    else if (imp) count -= imp[1] ? 2 : 1;
  }
  if (count <= 0) return null;
  const starts: number[] = [];
  let at = start;
  for (const segment of segments) {
    starts.push(at);
    at += segment.length + 1;
  }
  const last = segments[count - 1]!;
  if (col < start || col > starts[count - 1]! + last.length) return null;
  let i = 0;
  while (i < count - 1 && col > starts[i]! + segments[i]!.length) i++;
  return segments.slice(0, i + 1).join(".");
}

/** `base` plus a `/`-separated relative path. */
function join(base: string, rel: string): string {
  const clean = base.replace(/\/+$/, "");
  return rel ? `${clean}/${rel}` : clean;
}

/** Whether `path` is a folder: `fsReadDir` fails for files and missing folders. */
async function isFolder(path: string): Promise<boolean> {
  try {
    await call(commands.fsReadDir(path));
    return true;
  } catch {
    return false;
  }
}

/** Absolute JVM source / test roots of the open project and its workspace members. */
function jvmSourceRoots(): string[] {
  const project = useProject.getState().project;
  if (!project) return [];
  const out: string[] = [];
  const add = (base: string, roots: readonly RootFolder[]) => {
    for (const root of roots) if (isJvmPackageRoot(root)) out.push(join(base, root.path));
  };
  add(project.root, currentRoots());
  for (const member of useProjectRoots.getState().attached)
    add(member.root, effectiveRoots(member.detected, member.structure));
  return out;
}

/**
 * The source root of `path`: its folder with the file's own package path removed — the mirror
 * of the package layout that also works before roots are detected.
 */
function mirroredRoot(path: string, ownPackage: string | null): string | null {
  const dir = dirname(path);
  if (!ownPackage) return dir;
  const suffix = ownPackage.split(".").join("/");
  if (!dir.endsWith(`/${suffix}`)) return null;
  return dir.slice(0, dir.length - suffix.length - 1) || "/";
}

/** How many leading folders `a` and `b` share. */
function sharedPrefix(a: string, b: string): number {
  const left = a.replace(/\/+$/, "").split("/");
  const right = b.split("/");
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n++;
  return n;
}

/** Absolute folders that could hold package `name`, the file's own source root first. */
function packageDirs(name: string, from: string, ownPackage: string | null): string[] {
  const rel = name.split(".").join("/");
  const dir = dirname(from);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (base: string | null) => {
    if (!base) return;
    const candidate = join(base, rel);
    if (seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  push(mirroredRoot(from, ownPackage));
  // The same module first: the root sharing the longest path with the file's folder.
  for (const base of jvmSourceRoots().sort((a, b) => sharedPrefix(b, dir) - sharedPrefix(a, dir))) push(base);
  return out;
}

/** The folder of package `name` used from `from`, or null when it is a library package. */
async function packageFolder(name: string, from: string, ownPackage: string | null): Promise<string | null> {
  for (const dir of packageDirs(name, from, ownPackage)) if (await isFolder(dir)) return dir;
  return null;
}

/** The folder of the package a `package` / `import` line at `offset` references, if any. */
export async function packageFolderAt(view: EditorView, offset: number): Promise<string | null> {
  const doc = docOf(view);
  if (!doc || doc.virtual || !JVM_LANGUAGES.has(doc.language)) return null;
  const line = view.state.doc.lineAt(offset);
  const name = packageNameAtLine(line.text, offset - line.from);
  if (!name) return null;
  // The declaration is within the first lines; no need to copy a large file on every hover.
  const head = view.state.doc.sliceString(0, Math.min(view.state.doc.length, 4096));
  return packageFolder(name, doc.path, DECLARED_PACKAGE.exec(head)?.[1] ?? null);
}

/**
 * Go to Declaration on a package name: selects its folder in the Project view. False when the
 * caret is not on a package name, or the package has no folder in the project.
 */
export async function revealPackageFolder(view: EditorView, offset: number): Promise<boolean> {
  const folder = await packageFolderAt(view, offset).catch(() => null);
  if (!folder) return false;
  return executeAction("navigate.selectInProjectView", folder);
}
