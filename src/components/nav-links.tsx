"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useHiveContext } from "@/components/hive-context";
import {
  buildDashboardNavigation,
  dashboardNavigationGroupIsActive,
  dashboardNavigationLinkIsActive,
  type DashboardNavigationGroup,
  type DashboardNavigationLink,
} from "@/navigation/dashboard-navigation";

export function NavLinks({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { selected, hives } = useHiveContext();
  const activeHiveId = selected?.id ?? hives[0]?.id;
  const { data: navCounts = { qualityFeedbackCount: 0, unreadOutcomesCount: 0 } } = useQuery({
    queryKey: ["nav-brief-counts", activeHiveId],
    enabled: Boolean(activeHiveId),
    queryFn: async () => {
      if (!activeHiveId) return { qualityFeedbackCount: 0, unreadOutcomesCount: 0 };
      const res = await fetch(`/api/brief?hiveId=${activeHiveId}`);
      if (!res.ok) return { qualityFeedbackCount: 0, unreadOutcomesCount: 0 };
      const body = await res.json();
      return {
        qualityFeedbackCount: Number(body.data?.flags?.pendingQualityFeedback ?? 0),
        unreadOutcomesCount: Number(body.data?.flags?.unreadOutcomes ?? 0),
      };
    },
    refetchInterval: 30_000,
  });
  const groups = buildDashboardNavigation({
    activeHiveId,
    qualityFeedbackCount: navCounts.qualityFeedbackCount,
    unreadOutcomesCount: navCounts.unreadOutcomesCount,
  });
  const activeGroupIds = groups
    .filter((group) => dashboardNavigationGroupIsActive(group, pathname))
    .map((group) => group.id);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set<string>(),
  );

  const navItemClassName = (isActive: boolean, indented = false) =>
    `flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 ${
      indented ? "ml-3" : ""
    } ${
      isActive
        ? "border-amber-400/25 bg-sidebar-accent font-medium text-foreground shadow-[inset_2px_0_0_rgba(255,197,98,0.85),inset_0_0_0_1px_rgba(255,197,98,0.13)]"
        : "border-transparent text-muted-foreground hover:border-white/[0.06] hover:bg-white/[0.045] hover:text-foreground"
    }`;

  const renderBadge = (badgeCount?: number) => badgeCount ? (
    <span
      aria-hidden="true"
      className="min-w-5 rounded-full bg-primary/18 px-1.5 py-0.5 text-center text-xs font-semibold leading-none text-amber-100"
    >
      {badgeCount}
    </span>
  ) : null;

  const renderLink = (link: DashboardNavigationLink, indented = false) => {
    const isActive = dashboardNavigationLinkIsActive(link, pathname);
    return (
      <li key={link.id}>
        <Link
          href={link.href}
          onClick={onClose}
          aria-current={isActive ? "page" : undefined}
          className={navItemClassName(isActive, indented)}
        >
          <span className="min-w-0 truncate">{link.label}</span>
          {renderBadge(link.badgeCount)}
        </Link>
      </li>
    );
  };

  const toggleGroup = (groupId: string, isExpanded: boolean) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (isExpanded) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (isExpanded) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  };

  const renderGroupDisclosure = (group: DashboardNavigationGroup, isExpanded: boolean, isActive: boolean) => {
    const badgeCount = group.links.reduce((total, link) => total + (link.badgeCount ?? 0), 0);
    const childrenId = `dashboard-nav-${group.id}-items`;

    return (
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={childrenId}
        onClick={() => toggleGroup(group.id, isExpanded)}
        className={navItemClassName(isActive)}
      >
        <span className="min-w-0 truncate">{group.label}</span>
        <span className="flex items-center gap-2">
          {renderBadge(badgeCount)}
          <span
            aria-hidden="true"
            className={`text-xs text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
          >
            ›
          </span>
        </span>
      </button>
    );
  };

  return (
    <nav aria-label="Dashboard" className="space-y-4">
      <ul className="space-y-1">
        {groups.map((group) => {
          const isActiveGroup = dashboardNavigationGroupIsActive(group, pathname);
          const hasChildren = group.links.length > 0;
          const isExpanded =
            expandedGroupIds.has(group.id) ||
            (!collapsedGroupIds.has(group.id) &&
              (activeGroupIds.includes(group.id) || Boolean(group.global && hasChildren)));
          const childrenId = `dashboard-nav-${group.id}-items`;
          const topLevelIsLink = Boolean(group.href && !hasChildren);

          return (
            <li
              key={group.id}
              className={group.global ? "border-t border-sidebar-border pt-3" : undefined}
            >
              {topLevelIsLink && group.href ? (
                <Link
                  href={group.href}
                  onClick={onClose}
                  aria-current={isActiveGroup ? "page" : undefined}
                  className={navItemClassName(isActiveGroup)}
                >
                  <span className="min-w-0 truncate">{group.label}</span>
                </Link>
              ) : (
                renderGroupDisclosure(group, isExpanded, isActiveGroup)
              )}
              {hasChildren && isExpanded ? (
                <ul id={childrenId} className="mt-1 space-y-1">
                  {group.links.map((link) => renderLink(link, group.global !== true))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
