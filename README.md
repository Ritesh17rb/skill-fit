# skill-fit

[npm](https://www.npmjs.com/package/@ritesh17rb/skill-fit) · [Source](https://github.com/Ritesh17rb/skill-fit) · [Issues](https://github.com/Ritesh17rb/skill-fit/issues)

Prepare a small, explainable set of coding skills for your task. Take it to your agent. Record what the project's checks actually verify.

```text
$ skill-fit plan --task "Fix duplicate webhook payments on retry"

Profile: bugfix | Agent: generic
Selected 2 skills (~246 instruction tokens)

[selected] webhook-safety-...
  Task terms: fix, duplicate, webhook, payments, retry; Declared bugfix profile
[selected] small-changes-...
  Task terms: fix; Declared bugfix profile
[skipped]  react-ui-...
  Missing project dependency: react (>=18 <20)
```

**Version 0.1.0: initial release.** Includes a CLI and TypeScript API. Node.js 22+ is required.

## Install

```sh
npx @ritesh17rb/skill-fit@0.1.0 --help
```

For repeated use:

```sh
npm install --global @ritesh17rb/skill-fit
skill-fit init
skill-fit plan --task "Fix duplicate webhook payments on retry"
```

For the library API, install with `npm install @ritesh17rb/skill-fit`. The CLI command remains `skill-fit`.

## Try it locally

From this package directory:

```sh
npm ci
npm run check
npm run demo
```

Install the CLI from your local checkout:

```sh
npm install --global .
skill-fit --help
```

Or use `node /absolute/path/to/skill-fit/dist/cli.js` without global installation.

## Use it in your project

```sh
skill-fit init
skill-fit scan
skill-fit plan --task "Fix duplicate webhook payments on retry"
skill-fit prepare --task "Fix duplicate webhook payments on retry" --agent cursor
```

`init` creates `skill-fit.config.json` and suggests existing `test`, `typecheck`, and `lint` npm scripts. Review these commands and skill roots. `scan` and `plan` do not write files or execute skills. `prepare` creates a session containing copies of the selected skill bundles, their hashes, a prompt, and an adapter entry point.

Skill sources are local. Use your existing installer, such as [Vercel's skills CLI](https://github.com/vercel-labs/skills), to obtain third-party skills. Then point skill-fit at them:

```sh
skill-fit scan --skills ./downloaded-skills
skill-fit prepare --task "Refactor the webhook handler" --skills ./downloaded-skills --agent codex
```

`--skills` can point at one skill directory or a collection, and can be repeated. Providing it replaces the configured roots. Home directories are excluded unless you pass `--global`. The default local roots are `.agents/skills`, `.claude/skills`, `.cursor/skills`, and `skills`. Plugin cache layouts require an explicit `--skills` path to the relevant collection. Bare rules files such as `CLAUDE.md` are detected as project instructions; skill imports require a directory with `SKILL.md`.

### Agent support

| Agent | Generated entry point | How to use |
| --- | --- | --- |
| Codex | `.agents/skills/skill-fit-session/SKILL.md` | In a fresh session invoke `$skill-fit-session` |
| Claude Code | `.claude/skills/skill-fit-session/SKILL.md` | In a fresh session invoke `/skill-fit-session` |
| Cursor | `.cursor/rules/skill-fit-session.mdc` | Manually attach `@skill-fit-session` |
| Generic | Session `prompt.md` only | Ask an agent with local file access to read that file |

These are file adapters, not agent launchers. The model is chosen in your agent. Compatibility means the agent can read the prepared instructions; it does not promise identical behavior across models. Agent clients were not launched during the automated tests. Generated formats follow [Codex skill documentation](https://developers.openai.com/codex/skills/), [Claude Code skills](https://code.claude.com/docs/en/skills), and [Cursor rules](https://cursor.com/docs/rules).

Your existing `AGENTS.md`, `CLAUDE.md`, and other rules are preserved. Only the generated entry point is updated on subsequent preparations. If you edit it, skill-fit refuses to overwrite it. Move your edited file aside or use `--agent generic`. Each adapter points to the most recently prepared session for that agent; older session prompts remain usable directly. **Other installed skills remain visible to your agent.** Preparation cannot enforce exclusive skill activation or disable global instructions.

### Record verification

Preparation prints a session ID. Before coding, optionally capture the initial state:

```sh
skill-fit verify --session SESSION_ID
skill-fit verify --session SESSION_ID --stage baseline --run
```

The first command previews the saved commands. `--run` executes them in your project directory. After your agent finishes:

```sh
skill-fit verify --session SESSION_ID --stage after --run
skill-fit report --session SESSION_ID
```

Checks come from the prepared session. Later config changes require a new preparation. Each execution creates a separate report, including exit status, duration, capped stdout/stderr, timeouts, and snapshot integrity findings. Missing executables are reported as errors. A changed or unreadable skill snapshot prevents checks from executing. Project instruction changes are advisory findings. No checks configured is `no-checks`, never a passing result.

The report explicitly distinguishes:

- Project check outcomes: measured.
- Whether the agent read or followed a skill: unobserved.
- Whether skills caused an improvement: not measured.

A failing baseline followed by passing checks is useful evidence about the code. It does not isolate the effect of the skills. This release does not run A/B agent evaluations, read agent transcripts, or claim automatic optimization.

### Full configuration

```json
{
  "version": 1,
  "skillRoots": [".agents/skills", ".claude/skills", "skills"],
  "maxSkills": 3,
  "maxTokens": 8000,
  "checks": [
    {
      "name": "regression tests",
      "command": "npm",
      "args": ["run", "test"],
      "timeoutMs": 120000
    }
  ]
}
```

Selection overrides:

```sh
skill-fit plan --task "Fix webhook retries" --profile bugfix --max-skills 2 --max-tokens 4000
skill-fit prepare --task "Fix webhook retries" --include webhook-safety --exclude react-ui
```

Use IDs from `scan` when names are ambiguous. Explicit inclusion fails if a skill is incompatible, conflicts with another included skill, is excluded, or cannot fit the budget. Profiles are `bugfix`, `feature`, and `refactor`; `auto` infers one from the task wording.

### Optional skill hints

Existing skills work without modification. For stronger compatibility checks, add `skill-fit.json` beside a skill's `SKILL.md`:

```json
{
  "tags": ["webhook", "payments", "retry"],
  "profiles": ["bugfix"],
  "dependencies": { "react": ">=18 <20" },
  "commands": ["graphify"],
  "rules": { "test-runner": "vitest" }
}
```

Use only hints that actually apply to your skill. `dependencies` refers to declared Node package ranges in the project. `commands` refers to executable names on PATH. Different values for the same `rules` key are treated as mutually exclusive. You can alternatively put the JSON object as a string in the standard frontmatter's `metadata.skill-fit` field. A sidecar takes precedence.

## How selection works

The first version uses deterministic matching, so plans are local, reproducible for the same inputs, and need no API key:

1. Discover standard `SKILL.md` directories and parse YAML frontmatter.
2. Score shared task terms in names, descriptions, and tags (4 points each); body-only matches (up to 3 points); declared profile matches (5); and compatible declared dependencies (2 each).
3. Put explicitly included skills first. Break ties by skill ID.
4. Exclude declared dependency mismatches, missing commands, duplicate instruction bodies/bundles, and conflicting declared rules.
5. Select within the skill count and estimated instruction token budget.

Highly similar descriptions produce advisory overlap findings. This is lexical matching, not a semantic contradiction detector. Version checks test whether **declared ranges intersect**, not the actual installed version or lockfile. Free-text `compatibility` fields are surfaced for review. Plain skills without structured hints cannot receive automatic dependency or rule checks.

Token estimates use `SKILL.md` character count divided by four. Supporting resources, other installed skills, system prompts, and agent overhead are excluded. The budget therefore bounds only selected instruction estimates, not total session context.

Selected bundles include supporting scripts, references, and assets with preserved relative paths. Bundle hashes cover file paths, contents, and sizes; file permissions are not preserved or hashed. Each snapshot is pinned by content, not a Git revision. IDs include the source directory and can differ between machines. Existing skill-directory symlinks are canonicalized; symlinks inside a bundle are rejected. `.git`, `node_modules`, and `.skill-fit` are omitted. Limits: 5 MB per file, 20 MB and 2,000 files per skill, eight discovery levels, 10,000 scanned directories.

## Demo: reproduce a real failed check

`examples/project` intentionally contains an incorrect webhook implementation and a failing retry test. It is a small exercise, not production payment code.

```sh
node dist/cli.js prepare --cwd examples/project --task "Fix duplicate webhook payments on retry" --agent generic
node dist/cli.js verify --cwd examples/project --session SESSION_ID --stage baseline --run
```

Give the printed prompt to your agent. After it fixes `examples/project/webhook.mjs`, run verification with `--stage after`. The package's own tests exercise this failing-to-passing workflow in temporary fixtures without changing the bundled exercise.

## Library API

```ts
import { createPlan, prepare, verify } from '@ritesh17rb/skill-fit';

const plan = await createPlan({
  cwd: process.cwd(),
  task: 'Fix duplicate webhook payments',
  agent: 'generic',
  roots: ['./skills']
});

const session = await prepare({ cwd: process.cwd(), task: plan.task });
// Runs configured project commands. Review the saved checks first.
const result = await verify({ cwd: process.cwd(), session: session.id, execute: true });
```

ESM only. TypeScript declarations are included. `discover`, `readSkill`, `loadConfig`, `init`, and `loadSession` are also exported.

## Operational details

- Planning/preparation make no network requests, call no models, and execute no skill scripts.
- Verification executes reviewed project commands with your user's permissions. It is not a sandbox. Scripts invoked through npm can themselves launch shells, access the network, or modify files.
- Direct verification commands use argument arrays and no shell interpolation. npm's JS CLI is invoked directly where available. Other Windows `.cmd`/`.bat` shims are unsupported; use `node` with an explicit tool entry point.
- Checks run sequentially, default to a two-minute timeout, and retain at most 64 KiB per output stream. Timeout termination attempts to stop the process tree. Descendants that detach from their parent can escape this mechanism.
- Reports can contain sensitive test output and absolute local paths. Add `.skill-fit/` to your project's `.gitignore`. The package adds no telemetry.
- Session manifests and snapshots are local records, not signed attestations. Anyone who can edit them can alter the evidence. Sessions must be used from their original project directory.
- Managed writes reject existing symlinks/junctions. This is not protection against an adversary concurrently changing the filesystem.
- Preparation uses `.skill-fit/prepare.lock` to serialize writers. If the process crashes, confirm it has stopped before removing a stale lock. Incomplete sessions lack a `READY` marker and cannot be verified.

Exit codes: `0` successful command or passing verification; `1` invalid input, errors, failed checks, or integrity failure; `2` executed verification with no configured checks. `--json` keeps successful output machine readable and formats CLI errors as JSON on stderr.

## Development

```sh
npm ci
npm run check
npm run smoke
npm pack --dry-run
```

CI is configured for Node.js 22 and 24 on Ubuntu and Windows. Automated tests cover task ranking, compatibility failures, conflicts, resource preservation, adapters, overwrite protection, command execution, output limits, timeout behavior, and the CLI workflow. Live agent behavior remains a separate integration validation step.
