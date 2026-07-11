import { requireResourceOwnedByHive, requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { readDeliverableBytes } from "@/deliverables/files";
import { getDeliverable } from "@/deliverables/queries";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id } = await params;
    const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
    if (!target.ok) return target.response;
    const deliverable = await getDeliverable(sql, id);
    const ownership = requireResourceOwnedByHive(deliverable?.hiveId, target.hiveId, { resourceName: "Deliverable" });
    if (!ownership.ok) return ownership.response;
    if (!deliverable) return new Response("Not found", { status: 404 });

    if (deliverable.renderMode === "external_url") {
      return Response.json({ data: { id: deliverable.id, publicUrl: deliverable.publicUrl, sourceUrl: deliverable.sourceUrl } }, { status: 200 });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readDeliverableBytes(deliverable);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const headers: Record<string, string> = {
      "Content-Type": deliverable.mimeType ?? (deliverable.renderMode === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8"),
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
    };
    if (deliverable.renderMode === "html") {
      headers["Content-Security-Policy"] = "sandbox";
    }

    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers,
    });
  } catch {
    return new Response("Internal server error", { status: 500 });
  }
}
