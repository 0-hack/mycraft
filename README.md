# ⛏ MyCraft

A browser-based, **mobile-friendly multiplayer Minecraft-style voxel game**.
Mine and place blocks in a shared, persistent world with other players online —
no installs, no plugins. Just open a URL.

> Built with Three.js (client) and Node.js + WebSocket + SQLite (server).

## Features

- 🌍 **Procedurally generated voxel city** — *Marina City*, a blocky metropolis of
  glass towers, neon supertrees, parks and a marina bay. The base world is
  generated deterministically in every browser from a shared seed, so only player
  *edits* travel over the network.
- 👥 **Real-time multiplayer** — see other players move, build and mine live over
  WebSockets, with name tags, a **live minimap** and chat.
- 🧑‍🎨 **Character customisation** — on first sign-in, design your avatar in a
  rotating 3D editor: hairstyle, face expression, accessories, shirt, pants,
  shoes and bag, each with its own colour, plus a one-tap **randomise**. Your look
  is saved and shown to everyone; tweak it anytime from the backpack.
- 💾 **Accounts + centralised saves** — register/log in, and your position,
  vitals, inventory, score and achievements are persisted to the server's SQLite
  database. The world itself is shared and persistent across sessions.
- 📱 **Playable anywhere** — desktop (mouse + keyboard, pointer-lock look) and
  mobile/tablet (fixed on-screen joystick, drag-to-look, action buttons).
- ⚔️ **Equipment, gear & PvP combat** — open your **Bag** (press `B`, or the 🎒
  button) to manage **Items**, **Gear** and **Crafting**. Equip weapons (sword,
  axe, pickaxe, spear, **bow**, **gun** — melee or ranged) and armour (helmet,
  chestplate, greaves, boots). Gear has stats: armour adds **defence** (damage
  reduction), boots add **agility** (move speed), weapons set **damage/reach**.
  **Craft and upgrade** gear with raw materials + cash. Aim at a player and use
  the primary action (left click / ⛏) to attack; players die at zero hearts and
  kills are announced.
- 🕺 **Animated avatars + third-person** — characters have articulated head, arms
  and legs that swing while walking/running, swing on attack, and a head that
  tilts to where the player looks. Toggle a **third-person camera** (press `V`, or
  the 👁 button) to watch your own character and show off your gear.
- 🧬 **RPG classes & leveling** — pick a starting **class/gene** (Soldier, Archer,
  Gunman, Mage, Artisan), each with stat biases and weapon-category strengths
  (e.g. the Mage wields **magic** none other can). Earn XP from mining, building
  and combat to **level up** (capped, medium curve) and spend points on
  **attributes** — Strength, Dexterity, Intelligence, Endurance, Vitality, Speed.
  Stats matter: strength boosts melee & mining, dexterity ranged, attack speed
  & **crit chance** (crits hit 1.8× as gold "!" numbers), intelligence magic,
  endurance defence, vitality max health, speed movement.
- ⛏ **Mining takes effort** — harder blocks take longer to break; a stronger
  player and the right tool (pickaxe/axe) speed it up. Heavier armour slows you
  down, lighter setups run faster.
- 🎓 **First-time tutorial** — new players get a skippable, device-aware guided
  tour (movement, mining, building, combat, skills, healing, sanctuaries and
  survival), plus a few seconds of **spawn protection**. It shows once per
  account, and you can reopen it anytime from ⚙ Settings → How to play.
- 👾 **Monsters & solo PvE** — harmless wandering **slimes** (great for
  beginners), zombies, fast **skeletons**, big slow **brutes** and a periodic
  **Warlord boss**, each with a distinct look. Aggressive monsters chase but are
  slower than you and **give up if you run far enough**; **stronger monsters
  ignore low-level players** unless attacked first; monster numbers scale with how
  many players are online, so you can **train solo** even when no one else is
  around. All melee — no annoying ranged pot-shots.
  Spawns **surge at night**. Slay them for XP, cash and material drops; they show
  on the minimap as red dots. The boss also performs a **telegraphed ground
  slam** — a red danger zone fills up over ~1.5s and you must move out before it
  detonates — so the fight rewards dodging, not just DPS. Spawn rate, cap and
  power are difficulty-driven and admin-tunable.
- ✨ **Class skills & status effects** — each class has **3 unique active skills**
  (e.g. Mage's Fireball/Frost Nova/Heal, Soldier's Cleave/War Cry/Charge) on a
  hotbar (keys Z/X/C or on-screen buttons with cooldowns). Learn/upgrade them
  with skill points earned every level, capped at 5. Skills apply **status
  effects** — Fireball/Power Shot/Bomb **burn** (damage over time), Frost Nova &
  Cleave **slow**, Frost Nova & Grenade **stun** monsters — plus timed
  damage/defence/speed buffs.
- 🛡️ **Moderation** — the admin panel shows recent chat and can **mute** or
  **ban** accounts; a configurable chat **rate limit** curbs spam.
- 🩹 **Healing patches & food** — collectible **medkits** (restore health) and
  **food** (restore hunger) are scattered at ground level all across the map;
  walk over one to bank it, then use it with `Q` (medkit) / `F` (food) or the
  on-screen buttons. Combat damage, heals and regeneration are
  server-authoritative so PvP stays fair.
- 🕊️ **Safe sanctuaries** — glowing no-danger zones (e.g. the Spawn Plaza) where
  **no monsters or PvP** can reach you and your **health & hunger refill fully**.
  They're also the only place you can save a custom respawn point.
- 💰 **Economy & loot** — mine blocks to collect **materials**, then **sell** them
  for cash from your backpack. Your cash and materials stay with you until you
  **die** — then they drop on the spot as lootable treasure for anyone still
  alive to grab. Unclaimed loot despawns after a day. Death resets your wealth
  (but keeps your score, level and achievements), so it pays to **build a
  defensive base** to protect your stash.
- 🛠 **Admin panel** — an authenticated `/admin.html` page to tune **difficulty**,
  spawn rates and the objects deployed, deploy pickups on demand, and manage
  accounts (reset, ban, mute, promote, delete). Idle accounts are auto-purged to keep
  the server lean, and players can delete their own account from the backpack.
- 🎮 **Gamified** — health & hunger survival, fall damage, swimming, XP & levels,
  a score for mining/building/fighting, unlockable **achievements**, a global
  **leaderboard**, and a synced **day/night cycle**.

## Install & run

MyCraft runs as a single self-contained Docker container, so the steps are the
same on **Linux, Windows and macOS** — only the way you install Docker differs.

### 1. Install Docker

| OS | What to install |
| -- | --------------- |
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (uses the WSL 2 backend). |
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Apple Silicon or Intel), or [OrbStack](https://orbstack.dev/) / Colima. |
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) + the Compose plugin (`docker-compose-plugin`). |

Verify it's ready: `docker compose version`.

### 2. Get the code and start it

```bash
git clone https://github.com/0-hack/mycraft.git
cd mycraft
docker compose up -d --build
```

Then open **http://localhost:4000** in your browser, register an account, and play.
(On Windows, run the commands in PowerShell, WSL, or Git Bash — they're identical.)

### 3. Manage it

```bash
docker compose ps                  # show status
docker compose logs -f             # follow logs
docker compose down                # stop (keeps your saved world & accounts)
docker compose down -v --rmi all   # remove EVERYTHING: container, image, and data
```

Your world and accounts persist in the `mycraft_data` Docker volume (mounted at
`/data` inside the container) and survive restarts and rebuilds — only
`down -v` deletes them. Before exposing the server to other people, edit
`docker-compose.yml` and set `JWT_SECRET` to a long random string; you can also
change `WORLD_SEED` or the published port (`4000:4000`) there.

### Running without Docker (optional)

If you'd rather run it directly with [Node.js](https://nodejs.org/) 18+:

```bash
npm install
npm start
# open http://localhost:4000
```

Configure it with the `PORT`, `WORLD_SEED`, `JWT_SECRET`, `DATA_DIR` and
`ADMIN_USERNAME` environment variables. Game data is stored in
`./data/mycraft.sqlite`.

### Admin access

The account whose name matches `ADMIN_USERNAME` (default `admin`), **or** the
very first account registered on a fresh server, is granted admin rights. Sign
in at **`/admin.html`** with that account to manage difficulty, deployed objects,
lifecycle settings and accounts. You can also promote other accounts to admin
from there.

## Controls

| Action               | Desktop                        | Mobile                          |
| -------------------- | ------------------------------ | ------------------------------- |
| Move                 | `W` `A` `S` `D`                | Left-thumb joystick             |
| Look                 | Mouse (click to lock pointer)  | Drag on right half of screen    |
| Jump / swim up       | `Space`                        | ⤴ button                        |
| Sprint               | `Shift`                        | —                               |
| Break block / attack | Left click                     | ⛏ button                        |
| Place block          | Right click                    | 🧱 button                       |
| Select block         | `1`–`9` / scroll wheel         | Tap a hotbar slot               |
| Swap weapon / axe    | `1` (tap slot 1 again)         | Tap slot 1 again                |
| Class skills         | `Z` `X` `C`                    | Skill buttons by ⛏              |
| Use healing patch    | `Q`                            | 🩹 button                       |
| Eat food             | `F`                            | 🍗 button                       |
| Fly (if granted)     | Hold `Space`                   | Hold 🪽 button                  |
| Toggle view          | `V`                            | 👁 button                       |
| Bag                  | `B`                            | 🎒 button                       |
| Character (skills)   | `K`                            | ⭐ button                       |
| Settings             | `O`                            | 👤 button                       |
| Chat                 | `Enter` or `T`                 | —                               |
| Mute                 | `M`                            | ⚙ Settings → 🔊                 |
| Leaderboard          | 🏆 button                      | 🏆 button                       |

## Architecture

```
server/
  server.js   Express static host + REST (auth, leaderboard, status) + WS hub
  game.js     Multiplayer state, combat, mobs, pickups, single-session, autosave
  world.js    In-memory block-edit overlay backed by SQLite
  settings.js Difficulty presets + admin-tunable live settings
  auth.js     Register/login, bcrypt hashing, JWT tokens
  db.js       SQLite schema + prepared statements
  config.js   Tunables (port, seed, day length, secrets)
public/
  index.html, admin.html, css/style.css
  js/main.js     Game loop, renderer, input wiring, day/night
  js/worldgen.js Shared deterministic city generator + safe zones (client & server)
  js/world.js    Chunk meshing on top of worldgen
  js/player.js   Physics, collision, raycasting, survival
  js/blocks.js   Block palette + procedural texture atlas
  js/mobs.js     Monster type definitions + drops (shared with server)
  js/character.js Avatar model + customisation editor
  js/network.js  Auth + WebSocket client
  js/ui.js       HUD, hotbar, achievements, leaderboard, chat
  js/tutorial.js First-time guided tour
  js/mobile.js   Touch controls
  js/admin.js    Admin panel client
  js/noise.js    Seeded Perlin/fBm noise
```

The world is **shared**: the procedural city is identical for everyone (same
seed via `worldgen.js`, used by both the client renderer and the server), and
only the *differences* — blocks players break or place — are stored server-side
and synced to all clients. Per-player progress (vitals, score, level,
achievements, last position) is saved per account. Combat, health and pickups
are **server-authoritative**, and each account is limited to **one live session**
at a time.
