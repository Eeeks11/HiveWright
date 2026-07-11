# Discord EA ingress and sandbox policy

The `ea-discord` connector is an inbound owner-control surface. Treat every Discord message, interaction, attachment URL, and command argument as untrusted input until it passes the configured owner and scope checks.

## Required install configuration

Every active `ea-discord` install must include placeholder-safe Discord snowflake IDs only:

- `applicationId`: Discord application ID, for slash command registration.
- `channelId`: the single Discord channel the EA may read for non-DM traffic.
- `ownerUserIds`: one or more Discord user IDs allowed to issue messages and slash commands.
- `guildId` (optional): if set, non-DM messages and slash commands must come from this guild.
- `directMessagesEnabled` (optional): DMs are disabled by default. Set `true` only when the owner explicitly wants DM ingress, and DMs are still accepted only from `ownerUserIds`.

Existing installs that do not have at least one valid `ownerUserIds` snowflake must remain fail-closed. Do not mutate live install rows automatically; the owner must explicitly edit/re-save connector config and restart the dispatcher.

## Ingress order

Message and slash-command listeners must reject unauthorized traffic before any side effect, including channel queueing, SQL reads/writes, idea capture, attachment fetch/write, thread persistence, prompt construction, typing indicators, or `runEa`.

## Execution policy

Discord-originated EA turns run Codex in an isolated runtime directory under `EA_RUNTIME_ROOT` (default `/tmp/hivewright-ea-runtime`) with:

- no `--dangerously-bypass-approvals-and-sandbox` flag;
- explicit `--sandbox workspace-write` and `--ask-for-approval on-request` args;
- minimal allowlisted environment variables only, not the dispatcher process environment;
- isolated HOME/XDG directories for Codex config/cache.

This change does not re-enable any disabled `ea-discord` installs. Re-enablement is a separate owner/runtime operation after connector config is updated and reviewed.
