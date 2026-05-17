import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeliverableDetail } from "./queries";

export function safeHeaderFilename(filename: string): string {
  return filename.replace(/[\r\n]/g, "_").replace(/"/g, '\\"');
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveDeliverableFilePath(deliverable: Pick<DeliverableDetail, "filePath" | "workspacePath">): Promise<string> {
  if (!deliverable.filePath || !deliverable.workspacePath) {
    throw new Error("Deliverable has no workspace-backed file");
  }

  const workspace = path.resolve(deliverable.workspacePath);
  const candidate = path.isAbsolute(deliverable.filePath)
    ? path.resolve(deliverable.filePath)
    : path.resolve(workspace, deliverable.filePath);

  if (!isPathInside(candidate, workspace)) {
    throw new Error("Deliverable file path escaped hive workspace");
  }

  const [realWorkspace, realFile] = await Promise.all([
    fs.realpath(workspace),
    fs.realpath(candidate),
  ]);
  if (!isPathInside(realFile, realWorkspace)) {
    throw new Error("Deliverable real path escaped hive workspace");
  }
  return realFile;
}

export async function readDeliverableBytes(deliverable: DeliverableDetail): Promise<Uint8Array> {
  if (deliverable.filePath) {
    const resolved = await resolveDeliverableFilePath(deliverable);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("Deliverable path is not a file");
    return new Uint8Array(await fs.readFile(resolved));
  }
  if (deliverable.content !== null) {
    return new TextEncoder().encode(deliverable.content);
  }
  throw new Error("Deliverable has no readable content");
}
