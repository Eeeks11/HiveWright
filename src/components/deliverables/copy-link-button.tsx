"use client";

import { useState } from "react";

export function CopyLinkButton({ href, label = "Copy link" }: { href: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const absoluteUrl = href.startsWith("http://") || href.startsWith("https://")
      ? href
      : `${window.location.origin}${href}`;
    await navigator.clipboard.writeText(absoluteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copyLink}
      className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
