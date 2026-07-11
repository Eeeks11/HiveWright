import { describe, it, expect, vi, beforeEach } from "vitest";

const discordMock = vi.hoisted(() => {
  class FakeClient {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    login = vi.fn(async () => "logged-in");
    destroy = vi.fn(async () => undefined);
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      return this.on(event, handler);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
      return true;
    }
  }
  const restPut = vi.fn(async () => undefined);
  class FakeREST {
    setToken = vi.fn(() => this);
    put = restPut;
  }
  return {
    clients: [] as FakeClient[],
    restPut,
    FakeClient,
    FakeREST,
  };
});

vi.mock("discord.js", () => ({
  Client: vi.fn(function Client() {
    const client = new discordMock.FakeClient();
    discordMock.clients.push(client);
    return client;
  }),
  REST: discordMock.FakeREST,
  Routes: {
    applicationGuildCommands: (appId: string, guildId: string) => `/apps/${appId}/guilds/${guildId}/commands`,
    applicationCommands: (appId: string) => `/apps/${appId}/commands`,
  },
  SlashCommandBuilder: class {
    private payload: Record<string, string> = {};
    setName(name: string) { this.payload.name = name; return this; }
    setDescription(description: string) { this.payload.description = description; return this; }
    toJSON() { return this.payload; }
  },
  Events: {
    ClientReady: "ready",
    MessageCreate: "messageCreate",
    InteractionCreate: "interactionCreate",
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  Partials: { Channel: 1 },
}));

import {
  authorizeDiscordOwnerInput,
  buildDiscordOwnerAuthConfig,
  normalizeDiscordSnowflakeList,
} from "@/ea/native/discord-auth";
import { startNativeEa } from "@/ea/native/connector";
import { maybeStartNativeEa } from "@/ea/native";

const OWNER = "123456789012345678";
const OTHER = "223456789012345678";
const CHANNEL = "333456789012345678";
const WRONG_CHANNEL = "333456789012345679";
const GUILD = "444456789012345678";
const WRONG_GUILD = "444456789012345679";

function baseConfig(overrides: Partial<Parameters<typeof startNativeEa>[1]> = {}) {
  return {
    discordToken: "bot-token",
    hiveId: "55555555-5555-5555-5555-555555555555",
    channelId: CHANNEL,
    guildId: GUILD,
    ownerUserIds: [OWNER],
    directMessagesEnabled: false,
    apiBaseUrl: "http://localhost:3002",
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    channelId: CHANNEL,
    guildId: GUILD,
    content: "hello",
    author: { id: OWNER, bot: false },
    attachments: { size: 0, values: () => [][Symbol.iterator]() },
    channel: { sendTyping: vi.fn(async () => undefined) },
    reply: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeSlash(overrides: Record<string, unknown> = {}) {
  return {
    isChatInputCommand: () => true,
    commandName: "status",
    channelId: CHANNEL,
    guildId: GUILD,
    user: { id: OWNER, bot: false },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    deferred: false,
    replied: false,
    ...overrides,
  };
}

beforeEach(() => {
  discordMock.clients.length = 0;
  discordMock.restPut.mockClear();
  vi.clearAllMocks();
});

describe("Discord EA owner auth config", () => {
  it("canonicalizes valid snowflake allowlists and drops invalid IDs", () => {
    expect(normalizeDiscordSnowflakeList(`${OWNER}\ninvalid, ${OWNER} ${OTHER}`)).toEqual([OWNER, OTHER]);
  });

  it("fails closed when channel or owner allowlist is missing/invalid", () => {
    expect(buildDiscordOwnerAuthConfig({ channelId: CHANNEL, ownerUserIds: [] })).toBeNull();
    expect(buildDiscordOwnerAuthConfig({ channelId: "not-a-snowflake", ownerUserIds: [OWNER] })).toBeNull();
    expect(buildDiscordOwnerAuthConfig({ channelId: CHANNEL, ownerUserIds: ["bad"] })).toBeNull();
  });

  it("accepts only authorized channel/guild traffic and keeps DMs disabled by default", () => {
    const auth = buildDiscordOwnerAuthConfig({ channelId: CHANNEL, guildId: GUILD, ownerUserIds: [OWNER] })!;
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: CHANNEL,
      guildId: GUILD,
      userId: OWNER,
      isDirectMessage: false,
    })).toEqual({ allowed: true });
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: CHANNEL,
      guildId: GUILD,
      userId: OTHER,
      isDirectMessage: false,
    }).reason).toBe("unauthorized-user");
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: WRONG_CHANNEL,
      guildId: GUILD,
      userId: OWNER,
      isDirectMessage: false,
    }).reason).toBe("wrong-channel");
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: CHANNEL,
      guildId: WRONG_GUILD,
      userId: OWNER,
      isDirectMessage: false,
    }).reason).toBe("wrong-guild");
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: null,
      guildId: null,
      userId: OWNER,
      isDirectMessage: true,
    }).reason).toBe("dm-disabled");
  });

  it("accepts authorized DMs only when explicit opt-in is configured", () => {
    const auth = buildDiscordOwnerAuthConfig({
      channelId: CHANNEL,
      ownerUserIds: [OWNER],
      directMessagesEnabled: "true",
    })!;
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: null,
      guildId: null,
      userId: OWNER,
      isDirectMessage: true,
    })).toEqual({ allowed: true });
    expect(authorizeDiscordOwnerInput(auth, {
      channelId: null,
      guildId: null,
      userId: OTHER,
      isDirectMessage: true,
    }).reason).toBe("unauthorized-user");
  });
});

describe("maybeStartNativeEa startup validation", () => {
  it("does not decrypt/register/start active installs missing owner allowlist", async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-key";
    const sql = vi.fn(async () => [{
      id: "install-1",
      hive_id: "55555555-5555-5555-5555-555555555555",
      config: {
        applicationId: "666456789012345678",
        channelId: CHANNEL,
      },
      credential_id: "cred-1",
    }]) as never;

    const handles = await maybeStartNativeEa(sql);

    expect(handles).toEqual([]);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(discordMock.restPut).not.toHaveBeenCalled();
    expect(discordMock.clients).toHaveLength(0);
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  it("does not decrypt/register/start active installs with invalid applicationId", async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-key";
    const sql = vi.fn(async () => [{
      id: "install-1",
      hive_id: "55555555-5555-5555-5555-555555555555",
      config: {
        applicationId: "not-a-snowflake",
        channelId: CHANNEL,
        ownerUserIds: [OWNER],
      },
      credential_id: "cred-1",
    }]) as never;

    const handles = await maybeStartNativeEa(sql);

    expect(handles).toEqual([]);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(discordMock.restPut).not.toHaveBeenCalled();
    expect(discordMock.clients).toHaveLength(0);
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });
});

describe("startNativeEa ingress rejects before queueing side effects", () => {
  it("does not queue unauthorized DM, disabled DM, wrong channel/guild, or unauthorized slash command", async () => {
    const sql = vi.fn(async () => []) as never;
    const queued = vi.fn();
    await startNativeEa(sql, baseConfig({ onAuthorizedQueued: queued }));
    const client = discordMock.clients[0]!;

    client.emit("messageCreate", makeMessage({ guildId: null, channelId: "dm", author: { id: OTHER, bot: false } }));
    client.emit("messageCreate", makeMessage({ guildId: null, channelId: "dm" }));
    client.emit("messageCreate", makeMessage({ channelId: WRONG_CHANNEL }));
    client.emit("messageCreate", makeMessage({ guildId: WRONG_GUILD }));
    client.emit("interactionCreate", makeSlash({ user: { id: OTHER, bot: false } }));

    await new Promise((resolve) => setImmediate(resolve));
    expect(queued).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("queues authorized configured-channel messages and slash commands", async () => {
    const sql = vi.fn(async () => []) as never;
    const queued = vi.fn();
    await startNativeEa(sql, baseConfig({ onAuthorizedQueued: queued }));
    const client = discordMock.clients[0]!;

    client.emit("messageCreate", makeMessage());
    client.emit("interactionCreate", makeSlash({ commandName: "unsupported-test-command" }));

    expect(queued).toHaveBeenCalledWith("message");
    expect(queued).toHaveBeenCalledWith("slash");
  });
});
