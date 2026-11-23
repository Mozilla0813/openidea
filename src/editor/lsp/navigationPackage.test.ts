import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";

type GotoResult = Awaited<ReturnType<typeof commands.lspGoto>>;
const { executeAction, fsReadDir, lspGoto } = vi.hoisted(() => ({
  executeAction: vi.fn(async () => true),
  fsReadDir: vi.fn(),
  lspGoto: vi.fn<typeof commands.lspGoto>(async () => ({ status: "ok", data: [] })),
}));

vi.mock("@/platform/actions", async (orig) => ({
  ...(await orig<typeof import("@/platform/actions")>()),
  executeAction,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, fsReadDir, lspGoto } };
});

const { gotoTargets, navigationExtension } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { closePopup } = await import("./popupStore");
const { useProject } = await import("@/platform/project");
const { useProjectRoots } = await import("@/platform/projectRoots");
const { provideEditorService } = await import("@/workbench/contributions");

const openFile = vi.fn(async (_path: string, _opts: unknown) => {});
provideEditorService({ openFile } as never);

const PATH = "/p/src/main/java/com/acme/app/Main.java";

function editor(text: string) {
  return new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        lspDoc.of({ doc: 1, path: PATH, language: "java", uiMode: "java", readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
}

const found = (path: string): GotoResult => ({
  status: "ok",
  data: [{ path, uri: null, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } } }],
});

let view: EditorView | null = null;

beforeEach(() => {
  useProject.setState({ project: { root: "/p", name: "p", settings: {} } as never, settings: {} as never });
  useProjectRoots.setState({ root: "/p", detected: [], attached: [] });
  executeAction.mockClear();
  lspGoto.mockReset().mockResolvedValue({ status: "ok", data: [] });
  fsReadDir.mockReset().mockRejectedValue(new Error("not found"));
});

afterEach(() => {
  view?.destroy();
  view = null;
  closePopup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Go to Declaration on a JVM package name", () => {
  it("selects the package's folder in the project view instead of asking the server", async () => {
    fsReadDir.mockImplementation(async (path: string) => {
      if (path === "/p/src/main/java/com/acme/util") return [];
      throw new Error("not found");
    });
    const text = "package com.acme.app;\n\nimport com.acme.util.Helper;\n\nclass Main {}\n";
    view = editor(text);
    await gotoTargets(view, "definition", text.indexOf("util") + 1);
    expect(executeAction).toHaveBeenCalledWith("navigate.selectInProjectView", "/p/src/main/java/com/acme/util");
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("keeps the server's answer for a library package", async () => {
    const text = "package com.acme.app;\n\nimport java.util.List;\n\nclass Main {}\n";
    view = editor(text);
    await gotoTargets(view, "definition", text.indexOf("util") + 1);
    expect(lspGoto).toHaveBeenCalledTimes(1);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("still asks the server for the imported class itself", async () => {
    lspGoto.mockResolvedValue(found("/p/src/main/java/com/acme/util/Helper.java"));
    const text = "package com.acme.app;\n\nimport com.acme.util.Helper;\n\nclass Main {}\n";
    view = editor(text);
    await gotoTargets(view, "definition", text.indexOf("Helper") + 1);
    expect(lspGoto).toHaveBeenCalledTimes(1);
    expect(executeAction).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith("/p/src/main/java/com/acme/util/Helper.java", expect.anything());
  });
});
