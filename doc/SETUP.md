# EvEJS Setup

This is the clear, first-time setup guide.

If you are brand new to EvEJS, start here.

## What You Need

- a Windows PC
- Node.js `LTS`
- this repo on your machine
- a copied EVE client folder for **EVE 24.01 build 3396210**

Important:

- use a copied EVE folder
- do not point EvEJS at the same EVE install you use for normal live play
- the supported compatibility point is build `3396210`, validated June 16, 2026
- the setup wizard will warn when the selected client is older or newer

## The One-Time Setup

### 1. Install Node.js

Install the current `LTS` release from:

- `https://nodejs.org`

You only need to do this once.

### 2. Run the setup

Double-click:

```text
SetupEveJS.bat
```

That is the whole setup. It works through every step in the order that works:

- installs the packages the setup itself needs
- generates the local certificates
- installs the server packages
- downloads the public EVE SDE and builds the local database in `_local\gameStore`
- offers the optional standalone market
- opens the client wizard so your copied EVE client is patched and trusts the
  certificates

If Windows asks for permission during the certificate or patching steps, allow
it.

**It is safe to run again.** Every step checks what is already done and only
does the missing work, so if something fails or you close the window partway
through, just run it again. To see where you are without changing anything:

```text
SetupEveJS.bat -Status
```

Setting up a server that nobody plays on directly? Skip the client entirely:

```text
SetupEveJS.bat -SkipClient
```

### 3. Start the server and game

Double-click:

```text
StartServer.bat
```

Then choose:

```text
2 = Server + Play
```

That starts the server, gives it a moment to come up, and then launches the game.

Choose `1` for server only. That works even on a machine with no EVE client
installed at all.

### Doing it by hand instead

You do not need any of this if you ran `SetupEveJS.bat`, but each step still has
its own launcher:

```powershell
npm ci
npm --prefix server ci
```

```text
tools\ClientSETUP\StartClientSetup.bat
tools\DatabaseCreator\CreateDatabase.bat
```

To rebuild the local database later:

```text
tools\DatabaseCreator\CreateDatabase.bat /force
```

The generated database is local machine data and is not committed to git.

## Daily Use

After the first setup is done, the normal routine is simple:

1. Double-click `StartServer.bat`
2. Choose `2`
3. Play

If you want the server running without launching the client, choose `1` instead.

## Upgrading From an Older Version

If you used EvEJS before the runtime data moved to a local SQLite database, you
do **not** need to do anything special. The next time you run `StartServer.bat`
it migrates your existing data automatically — it moves your old local data into
place and converts the runtime tables into the SQLite database. Your original
files are left untouched.

If you ever want to run the migration by hand:

```powershell
cd server
npm run db:migrate-legacy
```

First-time users can ignore this entirely — a fresh install has nothing to
migrate.

## What You Do Not Need To Do

You do **not** need to:

- edit certificates by hand
- patch the client by hand
- browse internal repo plumbing
- set up the standalone market just to log in

## Optional Market Setup

The standalone market is optional.

If you want it, follow:

- [MARKET_SETUP.md](MARKET_SETUP.md)

## If Something Feels Off

Start here:

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## The Shortest Possible Version

1. Install Node.js `LTS`
2. Run `npm ci`
3. Run `npm --prefix server ci`
4. Run `tools\ClientSETUP\StartClientSetup.bat`
5. Run `StartServer.bat`
6. Choose `2`
