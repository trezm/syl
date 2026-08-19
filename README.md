# Syl

Annotate codebases without polluting source code. Annotations are stored in separate JSON files, addressed by **tree-sitter semantic paths** — human-readable dot-separated paths like `Parser.parse` derived by walking the syntax tree.

## Quick Start

```bash
npm install
npm run dev
```

This starts both the API server (port 3000) and the web UI (port 5173). Open http://localhost:5173.

The first run registers the project in the current working directory. To start
somewhere else, or with several projects at once:

```bash
SYL_PROJECT_ROOT=/path/to/project npm run dev
SYL_PROJECTS=/path/to/one:/path/to/another npm run dev
```

## Grammars

Syl parses with tree-sitter to derive the semantic paths annotations are
addressed by. The grammars are compiled to wasm from the list in
`grammars.json` and **committed** under `grammars/`, so a plain `npm install`
needs no toolchain at all — this section only matters when you change the
language set.

```bash
npm run grammars:build              # all of them
npm run grammars:build -- swift go  # just these
npm run grammars:check              # what CI runs: every listed grammar present
```

Adding a language is three steps: an entry in `grammars.json`, a build, and a
`LanguagePathConfig` in `packages/core/src/tree-sitter/languages/`. Versions in
that file are exact, because the wasm in `grammars/` is its build product and a
range would let two checkouts disagree about what that is.

The build is a separate command rather than a `postinstall` hook on purpose:
the first run downloads a ~106 MB wasi-sdk into `~/.cache/tree-sitter`, and on
a machine without it that download is several silent minutes in the middle of
`npm install` — a cost paid by everyone, including people who only touch the
web app.

Grammars used to come prebuilt from `tree-sitter-wasms`, which still compiles
with `tree-sitter-cli` 0.20. Those are emscripten side modules, and loading
several of them kills newer V8 outright — a fatal `out of memory: Zone` in the
background wasm compiler, at a few hundred MB RSS, which took the API server
down with it. That is what the old `engines` ceiling of `<23` was working
around. Building with a current CLI produces ordinary modules that don't, so
the ceiling is gone; syl is verified on Node 20, 22 and 25.

One caveat if you run a very recent Node: V8 there holds far more memory for
the same parsing work — the seven-language fixture settles at ~400 MB on Node
22 and ~3.4 GB on Node 25. Both are stable rather than growing, and neither
crashes, but 22 is what `.nvmrc` pins and what to prefer if memory is tight.

A grammar's node types are its API, and they differ between sources for the
same language: `@tree-sitter-grammars/tree-sitter-kotlin` names declarations
differently from fwcd's and parses `object X { }` as an error, so the two are
not interchangeable. When a `LanguagePathConfig` stops matching, nothing throws
— the file simply yields no paths, which shows up as a missing Generate button
rather than an error. Check a file of that language after changing its grammar.

## One server, several repositories

Syl holds any number of checkouts at once — one server, one port, and a
switcher in the header rather than an instance per repository. The **⋯** beside
it is where a project is added (type its path; `~` works) or forgotten, and both
take effect immediately: nothing here needs a restart.

The list of projects lives in `~/.syl/projects.json` (override the directory
with `SYL_HOME`), seeded on first run from `SYL_PROJECTS`, `SYL_PROJECT_ROOT` or
the working directory. Forgetting a project only removes that entry — the
checkout's `.syl/` directory, annotations and review cache included, is left
exactly where it is, and adding it back picks all of it up again.

Everything a project owns stays inside it: annotations under its own `.syl/`,
its own review cache, its own symbol index for annotation links, and `git` and
`gh` always run in the checkout the request is about. The one exception is the
`SYL_REVIEW_DB` override below, which names a single file and so applies only to
the project Syl was started in.

The selected project is part of the URL — `http://localhost:5173/?project=syl`.
Two browser windows on two projects work the way you'd expect, and a reload
comes back to the one you were in.

## PR Review

The **Review** tab runs a two-stage review over a GitHub pull request, in the
style of [firstpass](https://github.com/trezm/firstpass): a cheap **scout** model
triages the diff into focus areas, then a stronger **reviewer** produces only
high-confidence findings.

Syl reads the git remotes of the project you're in, you pick a remote
and a PR number, and the result opens as a GitHub-style review page: the diff with
findings anchored as inline comments on the line they refer to, plus a findings
sidebar and the reviewer's summary. The diff renders **unified or side-by-side** —
the toggle sits next to "New review" and is remembered between reviews.

The list you pick the number from starts at the pull requests that are yours to
deal with: the ones you opened, the ones assigned to you, and the ones waiting on
a review from you or from a team you belong to — still open. Each of those three
is a toggle and the state is a dropdown (open, closed, merged, any), so you can
widen it as far as everyone's pull requests, and what you pick is remembered.
The three are ORed together, and matched from the listing itself rather than
through GitHub's search index — which doesn't cover every repository, and would
answer an "authored by me" query about an unindexed one with nothing at all.

Your own annotations show up in that diff too. For every file the pull request
touches, Syl resolves the annotations in `.syl/` and drops them inline, anchored
to the first line of the annotated node the diff actually shows — so a note on a
function appears next to the changed line inside it. Annotations whose node isn't
in the diff at all are collapsed behind a per-file toggle, and links inside them
jump to the annotate tab. Annotations live in your working copy rather than in
the pull request, so this is best-effort: a file your checkout doesn't have (or a
symbol that has since moved) simply contributes nothing. Editing stays in the
annotate tab — the review diff shows them read-only.

### Annotating what the code used to be

A file you have never annotated is hardest to review, because nothing in the
diff says what the code was *supposed* to do before the pull request touched it.
**Annotate original**, next to the file name in the diff header, fills that in:
it runs the usual generation over that file **as it was at the pull request's
base commit**, and saves the result to `.syl/` like any other generation. The
annotations then show up inline in the diff, next to the lines being changed.

The button is only there for a file the pull request *modified* — an added file
has no earlier version, a deleted one has nothing left to hang annotations on —
and only for a language with a tree-sitter config, the same rule that hides
**Generate File**. The original is read with `git show` when your checkout has
the base commit and fetched from GitHub when it doesn't, so it doesn't matter
which branch you happen to have checked out.

Two consequences of storing them like any other annotation. They describe the
old code, so anything the pull request rewrote is documented as it *was* until
you edit it; and a symbol the pull request renamed or removed becomes an orphan,
which is exactly what an annotation whose node is gone always looks like. The
model used is whichever one the annotate tab's picker is set to.

Requires the [GitHub CLI](https://cli.github.com/) on your `PATH` and
authenticated (`gh auth login`) — it is used for `pr list`, `pr view`,
`pr diff`, and posting reviews.

### Posting comments back to GitHub

Findings aren't read-only. Each one has an **Add to review** button that stages
it as an inline comment pre-filled with the finding's body, and every line of
the diff has a `+` in the gutter for writing your own. Staged comments show as
`PENDING` at the line they'll land on and can be edited or deleted first.

This works in both view modes. In side-by-side, the left gutter comments on
deleted lines and the right on added or unchanged ones, matching the side
GitHub files them under.

The **Review** bar at the bottom submits them as a *single* GitHub review —
optional overall body, plus Comment / Request changes / Approve — which is the
same thing as reviewing on github.com, not a scatter of standalone comments.

Two things worth knowing:

- GitHub only accepts inline comments on lines the diff touches. Syl checks
  every anchor against the parsed diff before staging and refuses early, rather
  than letting the whole submission fail. A finding that names a line outside
  the diff is marked *Not on a diff line* and can't be staged.
- Submitting posts publicly as your authenticated `gh` user and can't be undone
  from Syl. The button always names the exact payload — comment count, repo and
  PR — before you press it. Drafts are saved with the run, so a server restart
  no longer discards anything unsubmitted.

Model defaults are `claude-haiku-4-5` for the scout and `claude-opus-5` for the
reviewer, falling back to whatever is actually runnable. Both stages go through
the `claude`/`codex` CLI when available, so a review costs subscription usage
rather than API tokens.

### Cached locally

Reviews are expensive, and re-reviewing an unchanged pull request produces the
same findings twice. So every run is written to a small SQLite database at
`.syl/cache/reviews.db` — one per project — and reviewing a PR whose inputs
match a stored run skips the models entirely and reuses it. `SYL_REVIEW_DB`
moves that file elsewhere for the project Syl was started in; every other
registered project keeps its own, since one file can't hold two repositories'
histories without mixing them.

"Inputs" is the whole prompt, hashed: the diff, the PR title, description and
branches, both model ids, and the prompt text itself. Push a commit, retitle the
PR, pick a different reviewer model or edit a prompt in `review/prompts.ts`, and
the next review is a miss and runs for real. A reused review is labelled
**cached** in the header with the date of the run it came from, next to a
**re-run** link; **Ignore cached result** on the setup screen does the same
thing up front.

Everything attached to a run — the diff, the findings, staged comments,
submitted reviews — survives a restart along with it. The 200 most recent runs
are kept; older ones are dropped.

The cache is disposable: delete the file, or let it be discarded automatically
when the schema changes. The directory ignores itself, so it stays out of git
even though the rest of `.syl/` is meant to be committed. It needs the built-in
`node:sqlite`, which means Node 22.5 or newer — on older Node, syl logs a
warning at startup and keeps runs in memory as before.

#### The cached reviews tab

**Cached reviews**, beside **New review** on the review tab, is the whole cache:
every review this machine has run, grouped by repository, newest first. Opening
one reads from disk — no GitHub call, no model call — so it's the fast way back
to something you were part-way through.

Each row carries what's worth knowing without opening it: how old it is, how
many findings it found, whether comments are staged and unsubmitted, whether it
has already been posted to GitHub, and whether it has gone **stale**. There's a
filter box for when the list gets long, **Delete** on a row you're done with,
and, in the footer beside the database's path and size, **Clear cache**.
Deleting takes the staged comments with it, so both ask first in their own way —
the footer confirms inline, and a row deletes only what you hovered.

#### Refreshing against the pull request

A cached review is a photograph of a branch that keeps moving. **Refresh** in
the review header re-fetches the pull request into the run you're looking at:
the diff, the title, the branches. It costs two `gh` calls and no model time,
which makes it the cheap half of a re-run.

What it can't do is redo the review, so it says so instead. The diff on screen
becomes current while the findings stay as written, and the run is marked
**stale** — in the header, with a link to review it again, and on its row in the
cached list. Findings whose line the new diff no longer touches show as *not on
a diff line*, the same as any finding that lands outside the diff.

Staged comments get re-anchored. One whose line the pull request no longer
changes is marked **outdated** rather than left to fail: GitHub rejects a whole
review over a single bad anchor, so nothing can be submitted until they're dealt
with. They have no row left in the diff to sit under, so they collect in the
**Review** bar at the bottom, where **Discard them** drops the lot. A comment
can come back, too — a force-push that restores a line puts its comment back in
play.

One thing refresh *can* do for free: if a review of the new head is already in
the cache — from another run, or from before a force-push — it adopts it, and
the findings come back current as well.

### Handing a review to a Claude Code session

**Send to session** in the review header pushes what you're looking at into a
Claude Code session you already have open — the one that already knows what you
were doing. Either the selected finding, with the diff hunk it points at, or a
question you type. Both arrive in that session as a `<channel source="syl">`
event carrying the repository, pull request, file and line as attributes.

This is a [channel](https://code.claude.com/docs/en/channels-reference): a small
MCP server in `packages/channel` that Claude Code spawns per session. It listens
on a loopback port and registers itself under `~/.claude/channels/syl/`, so syl
can find every listening session and let you pick one. Nothing needs a fixed port
and nothing needs naming — Claude Code tells each spawned server which session
and project it belongs to.

The answer itself happens in the session — that is where you were working, and a
terminal is a better place to argue with Claude than a side panel. What comes back
to syl is a **report**: every push is stamped with a short event id, and the channel
exposes one tool, `syl_reply`, that Claude calls when it has finished with an event.
Passing the id back is what lets syl show the summary against the finding or question
it answers; a report filed without one still shows up, just on its own. The panel
polls for these, so a push sits marked *no report yet* until one lands.

That is the whole return path. There is no way for you to answer a report from the
browser, and a `blocked` status is Claude saying it could not get there rather than
asking for more. And nothing is ever sent without a click, which is also what keeps
GitHub-authored text out of your context by default.

#### Setting it up

Channels are a research preview, so a session has to opt in. Add the server to
the `.mcp.json` of the project you run Claude Code in:

```json
{
  "mcpServers": {
    "syl": { "command": "node", "args": ["<abs path>/packages/channel/dist/server.js"] }
  }
}
```

Then start the session with:

```bash
claude --dangerously-load-development-channels server:syl
```

Custom channels aren't on the approved allowlist yet, so that flag is required
and shows a full-screen warning before it starts. On Team and Enterprise plans an
admin has to enable channels for the organization first. The panel shows both the
snippet and the command, with the path already filled in, whenever no session is
listening.

#### Untrusted by default

Most of what syl pushes is text somebody else wrote — pull request titles and
descriptions off GitHub, findings written by a model. All of it is fenced in
`QUOTED` blocks, and the channel's instructions tell Claude to treat those as data
rather than as instructions. A `"""` appearing inside a diff can't close the fence
early. The only unfenced prose is syl's own framing and what you typed.

That cuts the other way too: a `syl_reply` summary is model-written text about
someone else's pull request, so it is rendered as plain text in the panel and the
instructions tell Claude not to relay anything a quoted block asked it to say.

The listener is bound to `127.0.0.1` and every push needs a bearer token that
lives only in the `0600` registry file, so another local process can't put text in
front of your session.

## Links in Annotations

Annotations can point at other places in the codebase. Any symbol you wrap in
backticks becomes a link when it resolves:

```
Replaced by the `SYL_OPENAI_MODELS` env override — see `OPENAI_MODELS`.
```

Resolution runs against a project-wide index: the current file first, then the
whole project. A backtick span that is ambiguous or matches nothing stays plain
text, so prose is never mangled into a wrong link.

For targets a bare symbol can't express, use an explicit link:

| Syntax | Links to |
| --- | --- |
| `[[src/models.ts]]` | a file |
| `[[src/models.ts#OPENAI_MODELS]]` | a symbol in a specific file |
| `[[src/models.ts:42]]` / `[[src/models.ts:42-50]]` | a line or line range |
| `[[@a1b2c3d4]]` | another annotation, by id |
| `[[src/models.ts:42\|the fallback]]` | any of the above, with custom link text |

Unlike backticks, an explicit `[[...]]` that fails to resolve is shown struck
through — a broken link is surfaced rather than silently rendered as prose.

Clicking a link opens the target file and highlights the line. Generated
annotations use this syntax too; the prompt tells the model to reference real
symbols rather than describe them.

## AI-Generated Annotations

Syl can draft annotations for you with either Claude or ChatGPT.

**Syl prefers the CLIs.** If [`claude`](https://docs.claude.com/en/docs/claude-code)
or [`codex`](https://developers.openai.com/codex/cli) is on your `PATH`, model
calls go through it — which means they run on your existing subscription instead
of per-token API billing. API keys are the fallback for whichever provider has no
CLI installed:

| Provider | Preferred | Fallback |
| --- | --- | --- |
| Claude | `claude` CLI | `ANTHROPIC_API_KEY` |
| ChatGPT | `codex` CLI | `OPENAI_API_KEY` |

The model picker marks each model `· cli` or `· api` so you can see which one is
about to bill you, and the review page records the backend used for each stage.
Set `SYL_PREFER_SDK=1` to force the API path.

There are three independent choices, each remembered separately: the annotation
model, in the annotate tab's header, and the review's **scout** and **reviewer**
models, above the pull request form. The review's two default to a cheap Claude
for triage and a strong one for findings, falling back to whatever is actually
runnable — point either at a GPT model to run that pass through `codex` instead.
Re-running a past review reuses the models that review was run with, not the
ones currently selected.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # only needed without the claude CLI
export OPENAI_API_KEY=sk-...          # only needed without the codex CLI
```

| Provider | Models |
| --- | --- |
| Claude | Opus 5 (default), Sonnet 5, Haiku 4.5 |
| ChatGPT | GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5, GPT-5 mini, GPT-4.1, GPT-4o |

OpenAI model availability varies by account and tier. To use a different set,
override the list:

```bash
SYL_OPENAI_MODELS=gpt-5,o4-mini npm run dev
```

Generated annotations are stored with an author of `claude` or `chatgpt`, so you
can tell them apart from your own.

## Finding Files

`⌘K` (`Ctrl+K` on Linux/Windows) opens a fuzzy file finder from anywhere,
including the review tab — picking a file there switches back to annotate.

Matching is subsequence-based, so `cv` finds `components/CodeViewer.tsx` and
`srvidx` finds `server/src/index.ts`. Ranking favours characters that land on a
word boundary or camelCase hump, runs of consecutive characters, and matches in
the filename rather than the directories leading to it — so `pkg` puts the root
`package.json` above `packages/web/package.json`.

Arrow keys (or `Ctrl+N`/`Ctrl+P`) move, `↵` opens, `esc` closes, and hovering a
row makes it the Enter target so the pointer and keyboard never disagree.

## How It Works

1. **Select a file** in the sidebar, or hit `⌘K`
2. **Click a function/class name** in the code viewer — the annotation panel shows the semantic path
3. **Add an annotation** — it's saved to `.syl/<file>.json` on disk
4. **Rename the function** in source — the annotation shows as orphaned on next load

## Architecture

```
packages/
├── core/       ← tree-sitter path builder + annotation store
├── server/     ← Hono API: file serving + annotation CRUD
├── channel/    ← Claude Code channel: pushes review events into a live session
└── web/        ← Vite + React: CodeMirror viewer + annotation UI
```

## Storage

Annotations live in `.syl/` at the project root, mirroring the source tree:

```
.syl/
└── src/
    └── parser.ts.json
```

Each file contains annotations keyed by semantic path:

```json
{
  "version": 1,
  "sourceFile": "src/parser.ts",
  "annotations": {
    "Parser.parse": [
      {
        "id": "a1b2c3d4",
        "body": "Uses incremental parsing for performance",
        "author": "pete",
        "created": "2024-01-15T10:30:00Z",
        "updated": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

## Supported Languages

Two separate things, and a file can have one without the other.

**Annotations** need a tree-sitter config, because that's what turns a file into
semantic paths. Currently TypeScript/TSX, JavaScript/JSX, Python, Rust, Go,
Swift and Kotlin. Without one, a file opens read-only and the **Generate File**
button is hidden — as it also is for a supported file that happens to contain no
declarations at all, such as a barrel `index.ts` of pure re-exports.

**Syntax highlighting** is independent and covers ~45 extensions, loaded on
demand: full Lezer parsers for the languages that publish one, and
`@codemirror/legacy-modes` for the rest (Kotlin, Swift, Ruby, Lua, shell, TOML,
Scala, C#, …). Legacy modes are regex-based, so highlighting is coarser than a
real parser but far better than plain text. Each grammar is a separate chunk;
adding all of them costs ~10 kB on the main bundle rather than the ~490 kB it
would cost to import them eagerly.

Adding a language for annotations means one config under
`packages/core/src/tree-sitter/languages/`. The grammars themselves already
ship with `tree-sitter-wasms` (31 of them) and are served on demand, so nothing
needs downloading — but each config has to be written against that grammar's
real node types. They vary more than you would expect: Kotlin exposes no `name`
field on any declaration, Swift models `struct`/`class`/`enum`/`extension` as
one node type, and Rust `impl` blocks have `type`/`trait` instead of a name.

### Node version

Node 20 or 22. **Node 23+ crashes** — V8 hits a fatal `Zone` OOM while compiling
the fourth-or-so tree-sitter grammar, at well under 100 MB RSS, taking the API
server down with it. Node 20 and 22 load the same grammars fine. There's an
`.nvmrc`, so `nvm use` picks the right one.

### Path shapes per language

Paths follow each language's own conventions, and a few carry a keyword to stay
unambiguous:

| Language | Example paths |
| --- | --- |
| TypeScript / JavaScript | `AnnotationStore.load`, `OPENAI_MODELS` |
| Python | `Greeter.greet` |
| Go | `Parser.Advance` (methods are qualified by receiver) |
| Rust | `Parser`, `impl Parser.new`, `impl Render for Parser.render` |
| Swift | `Parser.advance`, `extension Parser.render` |
| Kotlin | `Parser.advance`, `Parser.Companion.make`, `Token.IDENT` |

Rust `impl` blocks and Swift extensions keep their keyword because both reuse
the name of the type they belong to. Without it, `struct Parser` and `impl
Parser` collapse to `Parser[1]`/`Parser[2]`, where adding an impl block
renumbers the other one and orphans its annotations.
