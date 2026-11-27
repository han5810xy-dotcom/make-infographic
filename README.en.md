# AI remembers every line. You remember one structure.

<img src="docs/assets/demo.gif?v=6" width="720" height="405" alt="Select a dialogue and generate an evidence-grounded knowledge structure" />

<img src="docs/assets/before-after-v2.png?v=1" width="720" height="450" alt="A plain summary beside an evidence-grounded knowledge atlas" />

Download [install.mjs](dist/install.mjs) and [make-infographic-2.1.1.zip](dist/make-infographic-2.1.1.zip) into the same folder, then run:

```powershell
node install.mjs
```

**Structure first. Pixels second.** Every proposition, relation, and gap points back to a source sentence. Nothing jumps directly from text to an image.

## Three entry points

- **Qwen browser extension**: captures the visible conversation and visible thinking as one Trace.
- **Qoder / DSH Skill**: select a dialogue and say **出图**.
- **Paste / file import**: Markdown, plain text, and common JSON exports.

All three routes produce the same complete Trace before entering the same structure workflow.

## Eight steps

1. Read the full dialogue and preserve turn indices.
2. Score repetition, follow-up, correction, and position.
3. Split content into single-assertion propositions with verbatim evidence.
4. Connect propositions only when the source states the relation.
5. Extract a 3–5 proposition backbone; declare parallel lists instead of inventing a spine.
6. Choose flow, tree, matrix, network, cycle, or forest from topology.
7. Check evidence, direction, layer, node limits, gaps, and cross-view consistency.
8. Render a main view, branch details, and a knowledge atlas.

## One visual grammar

Rectangles are propositions, circles are concepts, diamonds are judgments or conditions, hexagons are examples, and dashed boxes are inferences or gaps. Solid arrows mean causation, dashed arrows mean support, double arrows mean contrast, brackets mean containment, and orthogonal branches mean conditions. Blue marks the backbone and corrections, orange marks conflict and exceptions, gray marks background, and red marks refuted claims. Every view carries a quote / summary / inference badge.

The turn band remains available: **Before → Collision → Correction → Takeaway**.

## Website

- [Card library](https://chat-to-infographic-ue17fe4mvg7.qoder.zone/library.html): search by topic, status, and keyword.
- [Knowledge structure](https://chat-to-infographic-ue17fe4mvg7.qoder.zone/structure.html): move from atlas to backbone to evidence.
- [Profile](https://chat-to-infographic-ue17fe4mvg7.qoder.zone/profile.html): output history, topic distribution, and timeline.
- [Ambient art](https://chat-to-infographic-ue17fe4mvg7.qoder.zone/ambient.html): a separate decorative and commemorative output, stored separately from infographics.

## From diagrams to learning

Successful renders sync into the local `.knowledge/` store. The same proposition keeps one `concept_id` across dialogues, while sources, evidence, and learning events retain separate identities.

```bash
node scripts/learn.mjs due
node scripts/learn.mjs prompt <concept_id> --route explain
node scripts/learn.mjs answer <concept_id> --route explain --self-report without_looking --answer "your own words"
node scripts/learn.mjs reveal <event_id>
node scripts/learn.mjs serve --port 5279
```

The workbench collects the answer before revealing the source proposition and evidence. It includes a concept graph, the learner's explanation timeline, and per-route evidence records. It does not auto-grade or invent a mastery score. Learning bundles can be exported and restored on another machine.

## Acceptance numbers

- 50 private real dialogues: 471 propositions and 28 audited relations; 457 rendered images with 0 HTML fallbacks.
- Key-conclusion coverage: 91.3%. Topology consistency: 100%. Cross-view wording errors: 0.
- 24 render-width checks and 16 website checks; installers validate CRCs, stage changes, and roll back failures.
- Learning regressions cover cross-session identity, retrieval before reveal, append-only answers, export/restore, and concurrent writes.

These are engineering and structure-acceptance numbers, not proof of learning effectiveness. Private dialogues, answers, and evaluation data are excluded from public packages. Live Qwen extension checks and human expert review remain separate.

## Boundaries

- Split structures above 30 propositions by topic.
- Delete relations without a source sentence and record them as gaps; never connect an example to a main conclusion as causation.
- Main views have at most 7 nodes; detail views have at most 12.
- Failures degrade to another view, split views, or HTML only. Validation failure is never a deliverable.
- Uses installed Edge or Chrome; never downloads Chromium and needs no API key.

## License

MIT. See [LICENSE](LICENSE).
