import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const { executeAction, fsReadDir } = vi.hoisted(() => ({ executeAction: vi.fn(async () => true), fsReadDir: vi.fn() }));

vi.mock("@/platform/actions", async (orig) => ({
  ...(await orig<typeof import("@/platform/actions")>()),
  executeAction,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, fsReadDir } };
});

const { packageNameAtLine, packageFolderAt, revealPackageFolder } = await import("./packageNavigation");
const { lspDoc } = await import("./lsp");
const { useProject } = await import("@/platform/project");
const { useProjectRoots } = await import("@/platform/projectRoots");

const at = (line: string, word: string) => line.indexOf(word) + 1;

describe("packageNameAtLine", () => {
  it.each([
    ["a package declaration names the package up to the caret's segment", "package com.acme.util;", "acme", "com.acme"],
    ["the whole package under its last segment", "package com.acme.util;", "util", "com.acme.util"],
    ["the first segment", "package com.acme.util;", "com", "com"],
    ["Kotlin, without the semicolon", "package com.acme.util", "util", "com.acme.util"],
  ])("%s", (_name, line, word, expected) => {
    expect(packageNameAtLine(line, at(line, word))).toBe(expected);
  });

  it.each([
    ["an imported class is not a package", "import com.acme.util.Helper;", "Helper"],
    ["a regular wildcard's star", "import com.acme.util.*;", "*"],
    ["a static import's member", "import static com.acme.util.Helper.run;", "run"],
    ["the caret before the name", "import com.acme.util.Helper;", "import"],
  ])("%s", (_name, line, word) => {
    expect(packageNameAtLine(line, at(line, word))).toBeNull();
  });

  it.each([
    ["a regular import", "import com.acme.util.Helper;", "util", "com.acme.util"],
    ["a wildcard import", "import com.acme.util.*;", "util", "com.acme.util"],
    ["a static import", "import static com.acme.util.Helper.run;", "util", "com.acme.util"],
    ["a static wildcard import's class", "import static com.acme.util.Helper.*;", "Helper", "com.acme.util.Helper"],
    ["a Kotlin alias", "import com.acme.util.Helper as H", "util", "com.acme.util"],
    ["a Scala grouped import", "import com.acme.util.{Helper, Other}", "util", "com.acme.util"],
  ])("%s", (_name, line, word, expected) => {
    expect(packageNameAtLine(line, at(line, word))).toBe(expected);
  });

  it("ignores lines that are neither a package nor an import", () => {
    expect(packageNameAtLine("class Helper {}", 7)).toBeNull();
    expect(packageNameAtLine("// import com.acme.util.Helper;", 15)).toBeNull();
  });
});

const FILE = "/p/src/main/java/com/acme/app/Main.java";

function editor(text: string, path = FILE, language = "java") {
  return new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [lspDoc.of({ doc: 1, path, language, uiMode: language, readOnly: false })],
    }),
    parent: document.body,
  });
}

const IMPORTS = "package com.acme.app;\n\nimport com.acme.util.Helper;\n\nclass Main {}\n";

let view: EditorView | null = null;
const open = (...args: Parameters<typeof editor>) => (view = editor(...args));

beforeEach(() => {
  useProject.setState({ project: { root: "/p", name: "p", settings: {} } as never, settings: {} as never });
  useProjectRoots.setState({ root: "/p", detected: [], attached: [] });
  executeAction.mockClear();
  fsReadDir.mockReset().mockRejectedValue(new Error("not found"));
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("revealPackageFolder", () => {
  it("selects the folder a package's own source root mirrors", async () => {
    fsReadDir.mockImplementation(async (path: string) => {
      if (path === "/p/src/main/java/com/acme/util") return [];
      throw new Error("not found");
    });
    const v = open(IMPORTS);
    expect(await packageFolderAt(v, IMPORTS.indexOf("util") + 1)).toBe("/p/src/main/java/com/acme/util");
    expect(await revealPackageFolder(v, IMPORTS.indexOf("util") + 1)).toBe(true);
    expect(executeAction).toHaveBeenCalledWith("navigate.selectInProjectView", "/p/src/main/java/com/acme/util");
  });

  it("finds the package in another source root", async () => {
    useProjectRoots.setState({
      root: "/p",
      detected: [
        { path: "app/src/main/java", kind: "source", detectedFrom: "pom.xml" },
        { path: "lib/src/main/java", kind: "source", detectedFrom: "pom.xml" },
      ],
      attached: [],
    });
    fsReadDir.mockImplementation(async (path: string) => {
      if (path === "/p/lib/src/main/java/com/acme/model") return [];
      throw new Error("not found");
    });
    const text = "package com.acme.app;\n\nimport com.acme.model.Item;\n";
    const v = open(text, "/p/app/src/main/java/com/acme/app/Main.java");
    expect(await packageFolderAt(v, text.indexOf("model") + 1)).toBe("/p/lib/src/main/java/com/acme/model");
  });

  it("leaves a library package to the language server", async () => {
    const text = "package com.acme.app;\n\nimport java.util.List;\n";
    const v = open(text);
    expect(await revealPackageFolder(v, text.indexOf("util") + 1)).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("ignores the caret on the imported class", async () => {
    const v = open(IMPORTS);
    expect(await revealPackageFolder(v, IMPORTS.indexOf("Helper") + 1)).toBe(false);
    expect(fsReadDir).not.toHaveBeenCalled();
  });

  it("does nothing outside JVM languages", async () => {
    const v = open("package com.acme.app;\n", "/p/main.py", "python");
    expect(await revealPackageFolder(v, "package com.acme.app;".indexOf("acme"))).toBe(false);
    expect(fsReadDir).not.toHaveBeenCalled();
  });
});
