import type { ChatInputCommandInteraction, Message } from "discord.js";

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

export interface DiscordOwnerAuthConfig {
  channelId: string;
  guildId?: string;
  ownerUserIds: string[];
  directMessagesEnabled: boolean;
}

export interface DiscordOwnerAuthInput {
  channelId?: string | null;
  guildId?: string | null;
  userId?: string | null;
  isBot?: boolean;
  isDirectMessage: boolean;
}

export interface DiscordOwnerAuthDecision {
  allowed: boolean;
  reason?: string;
}

export function normalizeDiscordSnowflake(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DISCORD_SNOWFLAKE_RE.test(trimmed) ? trimmed : null;
}

export function normalizeDiscordSnowflakeList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const normalized = normalizeDiscordSnowflake(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseDiscordBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["true", "yes", "1", "on", "enabled"].includes(value.trim().toLowerCase());
}

export function buildDiscordOwnerAuthConfig(config: {
  channelId?: unknown;
  guildId?: unknown;
  ownerUserIds?: unknown;
  directMessagesEnabled?: unknown;
}): DiscordOwnerAuthConfig | null {
  const channelId = normalizeDiscordSnowflake(config.channelId);
  const guildId = normalizeDiscordSnowflake(config.guildId);
  const ownerUserIds = normalizeDiscordSnowflakeList(config.ownerUserIds);
  if (!channelId || ownerUserIds.length === 0) return null;
  return {
    channelId,
    guildId: guildId ?? undefined,
    ownerUserIds,
    directMessagesEnabled: parseDiscordBoolean(config.directMessagesEnabled),
  };
}

export function authorizeDiscordOwnerInput(
  auth: DiscordOwnerAuthConfig,
  input: DiscordOwnerAuthInput,
): DiscordOwnerAuthDecision {
  if (input.isBot) return { allowed: false, reason: "bot-message" };
  const userId = normalizeDiscordSnowflake(input.userId);
  if (!userId || !auth.ownerUserIds.includes(userId)) {
    return { allowed: false, reason: "unauthorized-user" };
  }
  if (input.isDirectMessage) {
    return auth.directMessagesEnabled
      ? { allowed: true }
      : { allowed: false, reason: "dm-disabled" };
  }
  const channelId = normalizeDiscordSnowflake(input.channelId);
  if (channelId !== auth.channelId) {
    return { allowed: false, reason: "wrong-channel" };
  }
  if (auth.guildId) {
    const guildId = normalizeDiscordSnowflake(input.guildId);
    if (guildId !== auth.guildId) return { allowed: false, reason: "wrong-guild" };
  }
  return { allowed: true };
}

export function messageAuthInput(message: Message): DiscordOwnerAuthInput {
  const guildId = message.guildId ?? null;
  return {
    channelId: message.channelId,
    guildId,
    userId: message.author.id,
    isBot: message.author.bot,
    isDirectMessage: !guildId,
  };
}

export function interactionAuthInput(interaction: ChatInputCommandInteraction): DiscordOwnerAuthInput {
  const guildId = interaction.guildId ?? null;
  return {
    channelId: interaction.channelId ?? null,
    guildId,
    userId: interaction.user.id,
    isBot: interaction.user.bot,
    isDirectMessage: !guildId,
  };
}
