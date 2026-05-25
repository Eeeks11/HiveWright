import { canAccessHive } from "@/auth/users";
import { readDeliverableBytes, safeHeaderFilename } from "@/deliverables/files";
import { getDeliverable } from "@/deliverables/queries";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id } = await params;
    const deliverable = await getDeliverable(sql, id);
    if (!deliverable) return new Response("Not found", { status: 404 });

    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, deliverable.hiveId);
      if (!hasAccess) return new Response("Forbidden", { status: 403 });
    }

    if (deliverable.renderMode === "external_url") {
      return new Response("External URL deliverables are not proxied", { status: 409 });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readDeliverableBytes(deliverable);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": deliverable.mimeType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeHeaderFilename(deliverable.filename)}"`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch {
    return new Response("Internal server error", { status: 500 });
  }
}
