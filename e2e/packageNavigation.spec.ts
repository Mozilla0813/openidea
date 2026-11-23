import { expect, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const FILE = `${ROOT}/src/main/kotlin/com/acme/orders/OrderController.kt`;

test("⌘-click on a Kotlin package name selects its folder in the Project view", async ({ workbench: page }) => {
  await page.evaluate(async (path) => {
    const editorModule = "/src/editor/core/controller.ts";
    const { editorController } = await import(/* @vite-ignore */ editorModule);
    await editorController().openFile(path);
  }, FILE);
  await expect(page.getByRole("tab", { name: "OrderController.kt" })).toHaveAttribute("aria-selected", "true");

  // The folders are read after the click: serve the tree from the sample file system.
  await stubDesktop(page);
  await page.evaluate(async (root) => {
    const fsModule = "/src/features/project-tree/fs.ts";
    const { sampleFs } = await import(/* @vite-ignore */ fsModule);
    const fs = sampleFs(root);
    window.__ipc.handlers.fs_read_dir = ({ path }) => fs.readDir(path as string);
  }, ROOT);

  const tree = page.getByRole("tree", { name: "Project" });
  const project = page.locator('[data-toolwindow="project"]');
  await project.getByRole("button", { name: "Collapse All", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("treeitem", { name: "com.acme.orders", exact: true })).toBeHidden();

  // ⌘-click the `orders` segment of `package com.acme.orders`.
  const point = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as unknown as {
      cmTile: {
        view: {
          state: { doc: { toString(): string } };
          coordsAtPos(pos: number): { left: number; top: number; bottom: number } | null;
        };
      };
    };
    const view = content.cmTile.view;
    const start = view.state.doc.toString().indexOf("com.acme.orders");
    const coords = view.coordsAtPos(start + "com.acme.".length + 1)!;
    return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
  });
  await page.keyboard.down("Meta");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Meta");

  const selected = tree.locator('[role="treeitem"][aria-selected="true"]');
  await expect(selected).toHaveText("com.acme.orders");
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem", { name: "com.acme.orders", exact: true })).toBeVisible();
});
