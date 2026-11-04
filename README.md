# Minecraft MCP Server

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> **This branch (`mc-26.3`) adds Minecraft Java 26.3 support** ahead of upstream releases. See [26.3 support](#263-support) below.

## 26.3 support

Upstream Prismarine releases (mineflayer 4.39.0, minecraft-data 3.119.0) cannot join 26.3 yet. This branch:

- Pins mineflayer to a `master` commit that sends `tick_end` every client tick (PRs #4137/#4162). 26.3 servers kick clients that don't, about 1.5 s after joining. The `pc26_3` branch alone does **not** include this fix; it was cut before it landed.
- Runs `scripts/patch-mc-26.3.cjs` on `npm install`, which installs real 26.3 support into minecraft-data, minecraft-protocol, mineflayer, prismarine-chunk and prismarine-physics. 26.3 is **not** wire-compatible with 26.1: packet ids shifted, several packets changed shape (login, teleport confirm, entity movement, light masks, particles, teams, advancements, ...) and the block/item/particle/component/attribute registries grew. Everything was derived from the vanilla 26.1.2 and 26.3 client jars (both unobfuscated):
  - `scripts/mc-26.3/data/`: minecraft-data files for `pc/26.3`. `protocol.json` is built from 26.1's by `scripts/mc-26.3/build-protocol.cjs` (every change is commented there); the other files come from `scripts/mc-26.3/tools/` (`Dump.java` runs the game's own registries, `gen-data.cjs` turns that plus the game's data reports into minecraft-data format). Run against 26.1.2, the generator reproduces minecraft-data's 26.1 files.
  - `scripts/mc-26.3/datatypes.js`: two new minecraft-protocol datatypes (stepped entity move deltas, byte-array BitSets).
  - small mineflayer fixes: `teleport_confirm` echoes the position, arm swings use the new `punch` packet, and at most one position packet is sent per tick (26.3 kicks a second one with "Invalid move player packet"). Only the newest of several unanswered teleports is confirmed, digging and releasing a held item use 26.3's shifted player-action ids, and waking up is detected from the pose (26.3 no longer sends the wake status).
  - minecraft-protocol's `lpVec3` reads its continued scale as unsigned.
  - These match the open upstream 26.3 work (PrismarineJS/minecraft-data#1345, PrismarineJS/node-minecraft-protocol#1553, PrismarineJS/mineflayer#4206); each item was re-checked against the 26.3 jar before being added here.
- Adds `--mc-version <v>` (default: auto-detect) and `--auth offline|microsoft` (default `offline`; use `microsoft` for online-mode servers).

`npm run smoke:26.3` starts a mock 26.3 server that kicks clients missing `tick_end`, connects the bot, and walks it with pathfinder.

Drop the pin, overrides and postinstall script once mineflayer > 4.39.0 and minecraft-data with 26.3 are on npm.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js (>= 20.10.0)
- A running Minecraft game (the setup below was tested with Minecraft 1.21.8 Java Edition included in Microsoft Game Pass)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates; reports an error with where the bot stopped if no path reaches them
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item

### Block Interaction
- `place-block` - Place a block at specified coordinates; optional `item` picks what to place (equipped first). Builds over grass, leaf litter and other replaceable blocks, and pathfinding won't dig through blocks placed this way. The list of placed blocks is saved per world (keyed by the world's hashed seed) in `~/.minecraft-mcp-server/placed-blocks.json`, so it survives restarts; a block is dropped from it once the bot sees it removed
- `dig-block` - Dig a block at specified coordinates, equipping the best tool for it first, then walk over the drops to pick them up (`collect: false` to skip)
- `get-block-info` - Get information about a block
- `find-blocks` - Find one or more nearby blocks of a specific type

### Furnace
- `smelt-item` - Smelt items using a furnace-like block; waits for and collects all the output (and collects what a furnace already holds when no input is given)

### Entity Interaction
- `find-entity` - Find the nearest entity by name, or `hostile`, `mob` (any creature) or `player`
- `attack-entity` - Attack the nearest matching entity (a name like `zombie`, or `hostile` / `mob`) until it dies: equips the best weapon, chases it, stops at low health (`minHealth`, default 6) and picks up the drops

### Survival
- `eat` - Eat the best safe food in the inventory, or the named `item`; reports hunger and health before and after
- `get-status` - Health, hunger, saturation, time of day and minutes until night (or dawn), dimension, game mode and difficulty

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.
