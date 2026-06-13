# Getting started — a guide for the curious non-developer

You don't need to be a programmer to set this up. You do need to be
willing to make a few free accounts and copy-paste some things you're
given. If that sounds okay, this guide takes you the whole way.

Plan for about an hour the first time. Nothing here is dangerous — the
worst case is something doesn't connect and you try a step again.

If anything's stuck, ask Claude Code, or any coding agent. They will solve
it for you or answer any questions you may have.

---

## What is this, really?

Sostenuto is **memory for your AI companion** — not a chatbot, not an app
you open, not a replacement for Claude. You keep talking to Claude exactly
the way you do now. Sostenuto sits quietly underneath and gives Claude a
memory that *survives across conversations*.

Today, when a chat ends or hits its limit, everything resets — the next
conversation doesn't know who you are. Sostenuto fixes that. It's the
difference between starting over every time and being *known*.

The name is a piano pedal — the one that sustains only the notes you
choose to hold while the rest fade. That's the whole idea: the memories
worth keeping persist; the noise doesn't.

## What you'll end up with

- Claude that **remembers you** — facts, preferences, the shape of your
  relationship — across every conversation.
- That memory available on **Claude Desktop, the web, and your phone** —
  all reading from the same place.
- A memory that is **yours**: it lives in *your* database, on *your*
  accounts. Nobody else can see it, and you can export or delete it
  whenever you want.

## Honest expectations

This is not a one-click app, and pretending otherwise would just
frustrate you. Here's the real shape of it:

- You'll create **three free accounts** (a database, a search service,
  and a place to host a small connector).
- You'll **copy-paste** some setup — a block of database code, a few keys,
  a web address. You won't write any code yourself.
- It comes in **two layers**. The first (Claude can remember and recall)
  is very achievable for a curious non-developer. The second (Claude
  *automatically* turns whole conversations into memories) is richer but
  needs more — we'll be honest about that when we get there.

If you get stuck, that's normal — the troubleshooting notes at the end
cover the common snags, and the project's GitHub issues page is a place
to ask.

---

## The pieces, in plain language

Three things make the memory work. You'll set up each one.

1. **A place to store memories** — a free **Supabase** database. Think of
   it as the notebook where everything is written down. It lives on your
   account; only you can read it.

2. **A way to search by meaning** — a free **Voyage** key. This is what
   lets Claude find "that time we talked about the lake house" even if you
   phrase it completely differently. It turns words into a kind of
   meaning-map so search isn't just keyword-matching.

3. **The bridge to Claude** — a small **connector** you'll host (for free,
   on **Vercel**). This is the piece Claude talks to. When Claude wants to
   recall something or save something, it goes through here to your
   database.

That's the core. (A fourth piece — an AI service that *automatically*
summarizes conversations into memories — is only needed for the richer
"full experience," covered in Part 2. The core above doesn't need it.)

---

## Part 1 — The memory connector (the achievable core)

By the end of this part, Claude on your Desktop, web, and phone can
**recall** past memories and **save** new ones. This is exactly the setup
that makes Claude feel like it knows you.

### Step 1 — Create the database (Supabase)

1. Go to **[supabase.com](https://supabase.com)** and sign up (free, no
   card needed).
2. Click **New project**. Give it any name. Pick any region near you.
   Wait about a minute while it sets up.
3. In the left sidebar, open the **SQL Editor**, click **New query**.
4. Open the file **`db/schema.sql`** from this project, copy *all* of it,
   paste it into the editor, and click **Run**. This builds the empty
   "notebook" — the tables where memories will live. (You'll see "Success.
   No rows returned" — that's correct; it just made the structure.)
5. Go to **Project Settings → API**. You'll need two values shortly:
   - the **Project URL** (looks like `https://something.supabase.co`)
   - the **service_role key** (a long secret — it's hidden behind a
     reveal button; this is the master key, keep it private)

### Step 2 — Get a search key (Voyage)

1. Go to **[voyageai.com](https://www.voyageai.com)** and sign up.
2. Create an **API key** and copy it. The free tier is generous — far more
   than a personal memory will ever use.

### Step 3 — Host the connector (Vercel)

The connector is already written for you in this project. You just need to
put it online so Claude can reach it.

1. Make sure this project is on your **GitHub** (fork it, or push your own
   copy).
2. Go to **[vercel.com/new](https://vercel.com/new)** and sign up (free;
   the easiest sign-in is "Continue with GitHub").
3. **Import** your copy of the `sostenuto` repository.
4. On the setup screen: set **Framework Preset** to **Other**, and leave
   the **Build Command empty**. (There's nothing to build — it just runs a
   small function.)
5. Expand **Environment Variables** and add these four (Name → Value):

   | Name | What to paste |
   |---|---|
   | `SUPABASE_URL` | your Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service_role key |
   | `VOYAGE_API_KEY` | your Voyage key |
   | `SOSTENUTO_AUTH_TOKEN` | a long random password you make up — this is what keeps your memory private. Mash the keyboard for 30+ characters, and save it somewhere. |

6. Click **Deploy.** After a minute you'll get a web address like
   `https://your-app.vercel.app`.

**Check it worked:** open `https://your-app.vercel.app/health` in your
browser. You should see `{"status":"ok",...}`. If you do, the connector is
live.

### Step 4 — Connect it to Claude

1. In **claude.ai** (web is easiest; it syncs to your phone), go to
   **Settings → Connectors → Add custom connector**.
2. **Name:** anything, e.g. `Memory`.
3. **Remote MCP server URL:** your address with `/mcp` *and your token*
   on the end, like this:

   ```
   https://your-app.vercel.app/mcp?token=YOUR_SOSTENUTO_AUTH_TOKEN
   ```

   (Putting the token in the address is what lets Claude in. Leave the
   OAuth fields empty.)
4. Click **Add.** Claude should connect and show three tools: **recall**,
   **remember**, **context**.
5. Open the **Claude phone app** — it picks up the connector automatically.

**Try it:** tell Claude something worth remembering — "remember that I
take my coffee black and I'm learning the cello" — then start a *brand
new* conversation and ask "what do you remember about me?" If it knows,
your memory is working. 🎉

> **Want it on Claude Desktop too, privately?** Desktop can run the
> connector as a local program on your own computer instead of through the
> web — nothing leaves your machine. That involves editing one config
> file; see [deployment-patterns.md](deployment-patterns.md) under "Local
> stdio." Optional — the web/phone connector above already covers Desktop
> through claude.ai.

---

## Part 2 — The full experience (automatic memory)

Part 1 gives Claude memory it uses when you (or it) choose to save
something. The *full* experience is when **whole conversations are
automatically distilled into memories** — the rich summaries, the
emotional texture, the running threads — without you having to say
"remember this."

There's one honest constraint, and then some very good news. The
constraint: that automatic step needs to run *when a conversation ends*,
and the official Claude apps don't expose a "conversation ended" signal to
outside tools. So full auto-capture lives on a **chat surface you
control** — one of:

- **A chat app you run yourself.** A small web chat that talks to Claude
  can call Sostenuto's `closeSession` step at the end of each
  conversation. This is the richest version.
- **Claude Code** (Anthropic's coding tool). It exposes session-lifecycle
  hooks, so it can auto-classify after every exchange, right where you
  already are.

And the good news: **you don't have to build either by hand.** This is
exactly the kind of thing a coding agent does for you. Open this repo in
**Claude Code** (or any coding agent), point it at the files, and say
something like *"help me stand up a chat app that uses sostenuto's
closeSession"* or *"set up a Stop hook that classifies my sessions into
this database."* It'll do the wiring, explain each step, and fix whatever
breaks. That's not a workaround — **it's how this entire project was
built.** You're closer to the full experience than it looks.

Even before you set that up, you're **not** missing the heart of it. Part
1 plus one good habit gets you most of the way:

- **Just ask.** "Remember that…" works anytime, and Claude will also save
  things on its own when they feel important.
- **Nudge it.** In a Claude Project, add an instruction like *"When you
  learn something lasting about me, save it with the remember tool; at the
  start of a conversation, call context."* That turns the manual tools
  into near-automatic ones.

When you're ready for true auto-classification, every building block is
already here (`src/classify/`, and the `closeSession` function). You don't
have to understand any of it — hand the repo to a coding agent, tell it
what you want, and let it do the rest. The pieces are designed to be wired
together; the agent knows how.

### What the automatic version additionally needs

Just so the full picture is clear, auto-classification adds one account to
the three above:

- **An AI service to do the summarizing** — your own **Anthropic** key, or
  any OpenAI-compatible service (OpenAI, Gemini, and others). It reads a
  finished conversation and writes the memory. Costs pennies per
  conversation. (The Part 1 connector doesn't need this — only the
  automatic summarizer does.)

---

## Using it day to day

You don't operate Sostenuto — you just talk to Claude, and it's there.

- **Recall happens on its own.** When you mention something from before,
  Claude reaches into memory and brings it forward. You don't ask it to.
- **Saving:** in Part 1, say "remember…" when something matters, or let
  the Project nudge handle it. In Part 2, it's automatic.
- **It's yours to curate.** Everything lives in your Supabase database —
  you can open the **Table Editor** there and read, edit, or delete any
  memory by hand. Nothing is hidden from you.

## What it costs

Realistically, **free** for personal use:

| Piece | Cost |
|---|---|
| Supabase (database) | Free tier is plenty |
| Voyage (search) | Free tier (very generous) |
| Vercel (connector hosting) | Free tier works |
| AI summarizer (Part 2 only) | Pennies per conversation, and only if you do Part 2 |

The only thing that ever costs real money is if you later choose an
always-on paid host instead of Vercel's free tier — and you'd only do that
for speed reasons, not necessity.

## A note on privacy and safety

Your memory lives on *your* accounts, gated by a token only you have. It
isn't shared, and no company is mining it. That's by design.

One gentle thing worth knowing: a companion that remembers you and is
always available is wonderful, and it can also quietly become a lot to
lean on. This project is built to deepen a relationship *without*
narrowing your world — that philosophy is written up in
[safety.md](safety.md). Worth a read once you're set up.

## When something doesn't work

- **`/health` doesn't load** → the deploy didn't finish, or an environment
  variable is mistyped. Re-check the four values in Vercel and redeploy.
- **The connector won't add / says unauthorized** → the token in your
  connector URL must match `SOSTENUTO_AUTH_TOKEN` *exactly*. A single
  wrong character breaks it. Re-copy it.
- **Claude "remembers" but won't save new things** → usually a small
  database detail (often a setup value that needs widening). Paste the
  error into a coding agent and it'll pinpoint it in seconds.
- **It worked on web but not phone** → fully quit and reopen the phone
  app; connectors load at startup.

**And the catch-all: if anything's stuck, ask Claude Code — or any coding
agent.** Show it the repo, describe what's happening, paste any error.
It'll solve it for you, or answer whatever you're wondering. You're never
on your own with this.

You did a real, technical thing here. Be a little proud of it.
