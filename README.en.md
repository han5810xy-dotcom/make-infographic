# AI remembers every conversation. You remember one image.

<img src="docs/assets/demo.gif?v=5" width="720" height="405" alt="Select a conversation in Qoder, type 出图, and get a four-part turn card" />

<img src="docs/assets/before-after.png?v=2" width="720" height="450" alt="A 600-character summary beside the four-part turn card" />

```powershell
curl.exe -L -o install.mjs https://raw.githubusercontent.com/han5810xy-dotcom/make-infographic/main/dist/install.mjs; curl.exe -L -o make-infographic-1.0.1.zip https://github.com/han5810xy-dotcom/make-infographic/releases/download/v1.0.1/make-infographic-1.0.1.zip; node install.mjs
```

**Before → Collision → Correction → Takeaway.** Not a summary — a record of how your thinking changed.

## Install

- With `pnpm`: the installer uses pnpm first, preserving the original working path.
- Without pnpm: it tries `corepack pnpm`, then falls back to `npm` / `npm.cmd` to install dependencies.
- With none of them: it prints three routes — `npm i -g pnpm`, `corepack enable`, or manual extraction with `--html-only` — instead of only telling you to install something.

Try it without installing: https://han5810xy-dotcom.github.io/make-infographic/

Release v1.0.1: https://github.com/han5810xy-dotcom/make-infographic/releases/tag/v1.0.1

Then select a conversation in Qoder and say: **出图**.

## Three examples

<p align="center">
  <a href="examples/01-curiosity/"><img src="docs/assets/01-curiosity.png?v=2" width="220" alt="Curiosity and spaced repetition" /></a>
  <a href="examples/02-skip-signal/"><img src="docs/assets/02-skip-signal.png?v=2" width="220" alt="Skipping is evidence" /></a>
  <a href="examples/03-repeat-node/"><img src="docs/assets/03-repeat-node.png?v=2" width="220" alt="Repeat nodes, not cards" /></a>
</p>

- [Curiosity and spaced repetition](examples/01-curiosity/): the forgetting curve is also a curiosity supply curve.
- [Skipping is evidence](examples/02-skip-signal/): a skipped probe is behavioral data, not noise.
- [Repeat nodes, not cards](examples/03-repeat-node/): keep the schedule, change the payload.

## Ten-minute validation

**Pending.** The author has not yet run the delayed-recall experiment with 10 real conversations and a three-day gap, so no number is claimed here.

Engineering checks are complete: clean install from the exact ZIP, natural-language trigger in Qoder, real dialogue rendering, resource reads, invalid-input rejection, PNG download, and mobile layout. Engineering success is not proof of learning effectiveness.

## Boundaries

- Visible body text is capped at 300 characters; overflow is trimmed without shrinking type, truncation, or ellipses.
- Missing Before, Collision, or Correction blocks stop rendering instead of inventing a twist.
- Non-verbatim text is marked as a summary in JSON and terminal output only.
- Uses installed Edge or Chrome; never downloads Chromium and needs no API key.
- Without a browser, only HTML can be generated and is explicitly marked untested.

## License

MIT. See [LICENSE](LICENSE).
