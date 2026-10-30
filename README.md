# openbee pi engine

An [openbee](https://github.com/theopenbee/openbee) engine plugin that runs tasks with the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It is built on [`@theopenbee/engine-sdk`](https://www.npmjs.com/package/@theopenbee/engine-sdk).

## Requirements

You install and configure pi yourself. The plugin only starts it.

```sh
npm i -g @earendil-works/pi-coding-agent
```

Give pi access to a model provider in one of two ways:

- Log in or configure providers with pi's own tools (`pi`, then `/login`), or
- Set the provider key as an environment variable in openbee's **Env** settings (for example `DEEPSEEK_API_KEY`). openbee passes its environment, including these settings, to pi.

The plugin itself needs Node.js 20 or newer (or Bun).

## Install

```sh
openbee plugin install pi
```

Or from npm by package name:

```sh
openbee plugin install @theopenbee/engine-pi
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/engine-pi.git
cd engine-pi
npm install
openbee plugin install "$(pwd)"
```

Then enable the plugin, and pick `pi` as the default engine or per worker.

## Settings

| Setting | Description |
|---|---|
| `path` | Path to the `pi` executable. Leave empty to use `pi` from `PATH`. |

The plugin checks the setting when it is enabled: it runs `pi --version` and shows the version, or the reason it failed (for example `pi not found on PATH`).

## Sessions

Every conversation maps to one pi session file:

```
~/.openbee/.pi/sessions/<session_id>.jsonl
```

This is the plugin's `state_dir/sessions`. openbee never deletes it, so sessions survive uninstalling the plugin and continue when you install it again. pi resumes a session when its file already exists. Token usage is read from the same files and summed per model.

## How it runs pi

```
pi --mode json --session <state_dir>/sessions/<session_id>.jsonl -p <prompt> [-e <package>/assets/openbee-mcp.js] [extra args]
```

- When openbee provides its MCP server, the plugin loads the bundled `assets/openbee-mcp.js` extension and sets `OPENBEE_MCP_URL`. The API key reaches pi through the `OPENBEE_API_KEY` environment variable, never through the command line.
- The log written for each run drops streaming deltas (`message_update`, `tool_execution_update`) and `thinkingSignature` fields.
- The result is the first text item of the last assistant message in the last `agent_end` event. A non-zero exit code or an assistant message with `stopReason: "error"` is reported as a failed run.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The end-to-end tests run the plugin against a fake `pi` script, under Node and under Bun when it is installed (`bun` on `PATH` or `~/.openbee/runtime/bun-*/bun`).

## License

MIT
