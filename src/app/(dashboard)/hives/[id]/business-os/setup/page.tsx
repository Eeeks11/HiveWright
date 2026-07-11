import Link from "next/link";

export default async function BusinessOsSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Business OS setup</p>
        <h1 className="text-2xl font-semibold">Set up or audit this business</h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Phase 0 exposes the owner-visible entrypoint and acceptance contract. The full setup/audit workflow is intentionally left for the recovery implementation cards.
        </p>
      </div>
      <Link href={`/hives/${id}`} className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
        Back to hive
      </Link>
    </div>
  );
}
