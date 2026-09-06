# Lightcone Lab: rich chat references and agent-opened tabs

The open AI-assisted research workbench

Status: first implementation. Updated: 6 September 2026.

Implemented here: inline chat previews, native record and cited-paper tabs,
fixed conversation context, and three MCP tools. No sibling-package changes.
The supported renderer is stock JupyterLab Markdown; `jupyterlab-myst` 2.7
falls back to its existing text rendering.

Give agents connected through Jupyter AI two capabilities: use MySTRA references
that display rich ASTRA previews inside chat, and open ASTRA elements as native
JupyterLab tabs. Build this in Lightcone Lab using current packages, with a small
local compatibility adapter where chat lacks a public rendering hook. No upstream
PR or release is a prerequisite.

## Recommended decisions

| Decision         | Recommendation                                                                              | Tradeoff                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Chat rendering   | Decorate the existing rendered message using its preamble hook                              | Works with current Jupyter Chat; we maintain a small adapter tied to its DOM structure           |
| Project context  | Bind each Lightcone conversation to one project and resolution context                      | Avoids guessing which project an agent reply refers to; use a new conversation to change context |
| Reference syntax | Support inline `{astra}` roles and custom labels first                                      | Full MyST documents, block embeds and value/citation roles are separate work                     |
| Element tabs     | Reuse existing ASTRA UI detail bodies in native widgets                                     | Unsupported targets use an existing owner/inventory surface or show a clear limitation           |
| Agent access     | Expose a narrow open-element tool, plus context/read tools, through the existing MCP server | Reuses Jupyter AI's browser routing; these UI tools require a connected browser                  |

## User experience

In Jupyter AI, the agent writes:

```markdown
The choice in {astra}`decisions.covariance_source` affects
{astra}`the BAO fit <outputs.bao_fit_plot>`.
Compare it with {astra}`clustering.outputs.xi_multipoles_plot`.
```

Each reference displays its label and ASTRA kind symbol. Hover or keyboard focus
opens a `RecordPreview` card, including a bounded figure/table/metric preview where
available. Clicking the reference opens the corresponding
record beside the conversation. The agent can open the same record directly by
calling a tool.

A project chip identifies the conversation's `astra.yaml`. **Discuss ASTRA project**
starts a bound conversation; **Add to chat** inserts a record reference and short
context into the editable composer. The existing Jupyter AI agent/model selector
and permission controls remain in charge.

This runs inside JupyterLab without `myst start` or an external theme server.
Previews show current project data; chat text remains unchanged when results change.

## What is available today

The inspected Jupyter AI **3.2.0** distribution uses Jupyter Chat 0.25, ACP client
0.3, persona manager 0.2, server MCP 0.3 and commands toolkit 0.2. Its base chat
works without a document RTC provider; RTC is optional.
[Package composition](https://github.com/jupyterlab/jupyter-ai/blob/7f6100e728d0c2ff52747f69247945dbb8fbd5fc/pyproject.toml).

| Existing API/component                                                                   | Use here                                                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `IChatTracker`, input toolbar registry, `input.getMetadata()` / `input.updateMetadata()` | Attach project controls and context to existing chats                              |
| `IMessagePreambleRegistry`                                                               | Mount a React component for each message with access to its content and chat model |
| Jupyter Chat's Markdown renderer                                                         | Preserve ordinary Markdown, math, mentions, code controls and message actions      |
| ASTRA UI `PreviewPopover` and `RecordPreview`                                            | Render accessible hover/focus cards, with shared styling and artifact adapters     |
| ASTRA UI standalone detail components                                                    | Fill native tabs without copying the inventory dialogs                             |
| `jupyter_server_mcp.tools` entry points                                                  | Register Lightcone tools in Jupyter AI's existing MCP server                       |
| Commands toolkit `execute_command`                                                       | Run a frontend command in the originating browser and return JSON                  |

Jupyter Chat has no public inline-body decoration hook. Its preamble registry is
public, but reaching from that component into the message body is a **local DOM
workaround**. The current renderer also does not pass message metadata to
RenderMime or dispose the renderer it creates. We should therefore leave its
renderer ownership intact and give our decorator its own cleanup.
[Message rendering](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/components/messages/message-renderer.tsx),
[preamble API](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/registers/preambles.ts).

MySTRA's build-time entry module imports Node APIs and is not a published browser
library. For now, vendor only its pure path/display parser into this repository,
retaining its license, source revision and relevant grammar tests. Define the
small inline role adapter locally using `markdown-it`, whose inline rules respect
Markdown code and escapes. This avoids bundling the build-time MyST stack.
Do not bundle the whole build-time plugin or introduce sibling `file:` dependencies.
[MySTRA grammar](https://github.com/LightconeResearch/MySTRA/blob/8b7dd79794912a9fc839e7075926d2081657c634/src/path.ts).

`jupyterlab-myst` is not required: its current parser has a fixed directive list
and no registered ASTRA roles. Installing it alone does not provide this feature.
Its alternative Markdown rendering needs a compatibility check, not an assumption
that it produces the same DOM.
[Parser source](https://github.com/jupyter-book/jupyterlab-myst/blob/402964a9b28d9dd7b617a125a22372d37359a5a2/src/myst.ts).

## Rich rendering with a local adapter

### Attach at the message, upgrade only the references

Register a Lightcone component with `IMessagePreambleRegistry`. It renders an
inert mount point and uses an effect to attach the decorator to that message.
The current layout puts the preamble and body under `.jp-chat-message`; the body
is `.jp-chat-rendered-message`. This gives us the actual message identity from
React, without matching messages by their order, text or sender.
[Current layout](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/components/messages/messages.tsx),
[preamble lifecycle](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/components/messages/preamble.tsx).

1. Parse `message.body` to identify actual `{astra}` role occurrences.
   Exclude fenced/inline code examples, escapes, unsupported roles and incomplete
   streamed syntax. Resolve the roles against the conversation's bound project.
2. Let Jupyter Chat render normally. Under ordinary Markdown, a role appears as
   literal `{astra}` text followed by an inline-code element containing its body.
   Match those rendered fragments to the parsed role occurrences, including
   repeated targets and custom labels. Upgrade only unambiguous matches; do not
   treat arbitrary code elements or model-supplied HTML as ASTRA references.
3. Replace the matched fragment with a small mount for a typed reference component.
   Render `PreviewPopover` + `RecordPreview` there, using React portals owned by
   the preamble component. Retain enough of the original fragment to restore it.
4. Observe replacements inside this message's body with a scoped `MutationObserver`.
   When streaming replaces the rendered content, discard detached mounts and
   decorate the new content. Ignore our own mutations and cancel
   obsolete asynchronous record lookups.
5. On edit, deletion, unmount or disposal, disconnect the observer, release project
   subscriptions, remove portals and restore still-attached original fragments.
   Do not touch the message toolbar, attachments, code-block controls or other
   extensions' preambles.

The source parser is essential: escaped examples can render like actual roles.
A count/order check alone cannot prove a match when literal examples coexist with
references. If source-to-DOM association is ambiguous, leave those fragments alone.
That is an explicit limitation of this approach, to exercise in the prototype.

This adapter depends on two DOM selectors and ordinary Markdown's rendering of
role syntax. Keep those assumptions in one module with tests against the supported
Jupyter Chat release. Tests confirm that `jupyterlab-myst` 2.7 strips unknown
role markers, so that renderer currently keeps its text without ASTRA cards. If the body structure or another Markdown renderer does not
match, preserve the original message and keep the open-element tools operational.
Do not replace the whole chat body or patch ACP response generation to compensate.

### Preview behavior

Use the existing ASTRA UI components, artifact access and paper adapters.
`PreviewPopover` already supports hover, focus, nested previews and explicit
portal scope/theme attributes; supply those attributes because a portal does not
inherit the chat subtree's styles. Provide Escape, click and touch access too.
[ASTRA UI exports](https://github.com/LightconeResearch/astra-ui/blob/0a0a2c4985ec51747be475a444205ece416072c6/packages/react/src/components/index.ts),
[popover contract](https://github.com/LightconeResearch/astra-ui/blob/0a0a2c4985ec51747be475a444205ece416072c6/packages/react/src/primitives/preview-popover.tsx).

Load bounded artifacts when a preview opens and share project resolution across
cards, inventory and tabs. Missing results show availability information; opening
or hovering never runs a recipe or downloads a paper automatically. Invalid paths
remain readable unresolved references. Temporary invalid YAML retains last valid
data with a notice. Live cards identify themselves as current project state.

## Project context without modifying Jupyter AI

Bind a **new** Lightcone conversation to one entrypoint and universe/defaults
context. Persist a versioned `lightcone` context object in the first sent user
message's metadata, and repeat it on subsequent outgoing messages using the
existing `input.getMetadata()` / `input.updateMetadata()` mechanism. Include a short visible context block so the
agent receives the project and reference instructions too: metadata alone is not
part of its prompt.
[Message metadata](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/types.ts).

On reload, derive the binding from the chat's persisted context messages. Keep it
fixed for that conversation. Switching files changes neither old references nor
in-flight responses; discussing another project or universe starts another chat.
All personas in the chat therefore interpret rooted MySTRA paths consistently,
even though current ACP replies do not inherit our metadata.

Do not retroactively enrich an existing unbound history based on the current file
browser. If binding metadata is missing or conflicting, show the context problem
and leave references unresolved. Repeating metadata makes deletion of the first
message recoverable, but deleting all binding messages loses that context. This
is simpler than server monkey-patching or inferring reply parents from timing.

Use the same validated target for clickable references and commands:

```json
{
  "entrypoint": "myst_proto/astra.yaml",
  "target": "clustering.outputs.xi_multipoles_plot"
}
```

Paths are rooted at the ASTRA entrypoint and normalized through MySTRA's grammar
and the SDK index, never resolved by display label. Preserve Jupyter Contents drive
prefixes. An optional `universeId` uses the existing SDK resolution option. Pin a
real selected root universe; with no universe files, omit that option and record
defaults context. The synthetic `default` ID is not an explicit universe file.
If a pinned universe disappears or defaults acquire universe files, show the
context change rather than silently choosing another configuration. Cited papers
use an explicit `doi` argument with an empty target; no new inline syntax is invented.

## Agent-opened elements

Register `jupyterlab_lightcone:open-element` in `src/commands.ts`. Wrap existing
ASTRA UI detail bodies in `ReactWidget` / `MainAreaWidget`, tracked and restored
through JupyterLab's `WidgetTracker` and `ILayoutRestorer`. These are views of
records, not new files or editable document models.
[JupyterLab widget guidance](https://jupyterlab.readthedocs.io/en/stable/extension/virtualdom.html).

| Target                                 | Existing surface                                      | Behavior                                                                                      |
| -------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Figure/table/metric/data/report output | `OutputDetail` and artifact adapter                   | Preview supported media and offer the full artifact                                           |
| Decision                               | `DecisionDetail`                                      | Rationale, options, selected option and linked insights                                       |
| Finding                                | `FindingDetail`                                       | Claim and evidence                                                                            |
| Prior insight                          | `InsightDetail`                                       | Claim and literature evidence                                                                 |
| Input                                  | `InputDetail`                                         | Source and relationships                                                                      |
| Cited paper                            | `PaperDetail` and existing PDF renderer               | Current cache/fetch/quote navigation                                                          |
| Option/evidence child                  | Owning record detail                                  | Open the owner and identify the requested child; focus it only where supported                |
| Analysis/collection                    | Existing inventory                                    | Navigate to that analysis scope in its automatic universe; reject a different pinned universe |
| Unsupported target/media               | Existing source/full-artifact action where applicable | Explain the limitation; do not build a new detail surface here                                |

Deduplicate tabs by entrypoint, canonical owning record (or DOI) and resolution
context; child navigation reuses the owner tab. Related-record actions open/focus
other tabs. Persist identifiers and selections, then resolve again on restoration.
Removed records keep an unavailable state instead of redirecting to another ID.
Show project/scope in captions to distinguish identical labels.

Extend the existing shared project service's entrypoint key with resolution
context where needed; do not add per-card polling. Jupyter Live Content does not
currently manage arbitrary third-party views, so keep our subscription lifecycle.
[Live Content scope](https://github.com/jupyter-ai-contrib/jupyter-live-content/blob/6073133dde634ffb26213ef4004cc7a5d70fa377/README.md).

### Tools and transport

Register thin Python wrappers through `jupyter_server_mcp.tools`. Each calls a
named frontend command through the installed commands toolkit, reusing the
frontend SDK resolver rather than implementing ASTRA resolution again in Python.

| Tool                                                             | Purpose                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `lightcone_open_element(entrypoint, target?, universeId?, doi?)` | Open/focus a record or cited-paper tab and return its resolved identity and opened/reused status             |
| `lightcone_project_context(...)`                                 | Return the bound project, active ASTRA view, capabilities and a bounded searchable list of reference targets |
| `lightcone_read_element(entrypoint, target?, universeId?, doi?)` | Return bounded record details, relationships, artifact availability and a ready-to-use MySTRA reference      |

Jupyter AI's MCP middleware derives `target_client_id` from the initiating user
message's `web_client_id`. Use that routing and the initiating message's bound
context, not whichever project is currently focused. Reject missing routing
before invoking the bridge: its default is to broadcast. Do not accept a browser
ID chosen by the model. Return JSON, never a widget object; distinguish missing
project/record, unsupported target, disconnected browser and timeout. A timeout is
unconfirmed, and deduplicated opening makes retry safe.
[Tool discovery](https://github.com/jupyter-ai-contrib/jupyter-server-mcp/blob/92f0c7b9b98dd1c796dae469ff50a4edd9cb9083/jupyter_server_mcp/extension.py),
[command bridge](https://github.com/jupyter-ai-contrib/jupyterlab-commands-toolkit/blob/6651eb6efd20689987f761d6e93178b6a7bb5d29/jupyterlab_commands_toolkit/tools.py),
[browser routing](https://github.com/jupyter-ai-contrib/jupyter-server-mcp/blob/92f0c7b9b98dd1c796dae469ff50a4edd9cb9083/jupyter_server_mcp/client_routing.py).

The existing generic `execute_command` tool could already call our new command;
the typed wrapper improves discovery, argument validation and routing checks.
These tools target agents inside Jupyter AI with a connected browser. Its MCP
server has a separate local transport; reuse the existing local/isolated
single-user deployment, without treating routing metadata as authentication.

## Relationship to the rest of Lightcone

Current `../lightcone-cli` main, commit `78059fa`, produces the expected single
output file at `results/<universe>/<id>.<format>`, consistent with the SDK's path
assumptions. Reuse SDK artifact bindings and verify representative root/nested
outputs as ordinary integration tests.
[Current CLI output contract](https://github.com/LightconeResearch/lightcone-cli/blob/78059fab1608b033370558cfef3f5d6ffad26084/src/lightcone/engine/assets.py).

Agents can continue using `lc` through their existing terminal tools and research
skills. This increment observes project changes; it does not add an execution
service. Put essential MySTRA examples and navigation guidance in the MCP tool
descriptions and explicit chat context so no skill-package change is required.
Existing `agent-skills` plugins remain useful for ASTRA authoring and the `lc`
workflow; check their discovery through supported ACP adapters.
[Existing skill composition](https://github.com/LightconeResearch/agent-skills/blob/38ac1be2186264f3cf582c6d199c1583e70fb68a/skills.config.json).

## Future changes that could simplify our implementation

These are optional follow-ups in other packages, not work to open upstream now.

| Package improvement                                                                  | Local code or restriction it could remove                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Jupyter Chat message-body renderer/decorator hook with lifecycle and message context | DOM selectors, mutation observation and source-to-DOM matching                             |
| Jupyter AI reply correlation and opt-in context propagation                          | Fixed context per conversation; enable safe project/universe changes between turns         |
| MySTRA published browser-safe reference parser                                       | Vendored grammar and synchronization tests                                                 |
| Shared ASTRA UI reference-trigger component                                          | Repeated label/glyph/preview composition across Lab and other hosts                        |
| `agent-skills` workbench guidance                                                    | Repeated onboarding examples in chat; richer discover/inspect/open workflows across agents |

## Implementation and validation

Keep this in the existing extension, with an optional AI integration plugin and
Python extra. Inventory and element tabs must still work without Jupyter AI.
Use released dependencies and deduplicated shared tokens. Keep the DOM workaround
in one module, separate from reference resolution and native tabs.

1. The local preamble decorator uses the current Jupyter Chat release:
   literal role matching, hover cards and cleanup during streaming are tested
   with a deterministic agent. No upstream changes are involved.
2. The vendored parser, validated targets and native detail tabs reuse existing
   project subscriptions and ASTRA UI.
3. Fixed chat context, **Add to chat**, and typed MCP tools are implemented.
   The fixture persona uses the same MCP settings and routing as ACP agents.

| Area             | Acceptance checks                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering        | Roles/custom labels in normal prose, lists and emphasis; repeated targets; escaped/code examples; malformed/incomplete roles; ambiguous matching preserves text |
| Lifecycle        | Streaming replacement, stale async completion, edit/delete, detached messages, cleanup and no observer feedback loops                                           |
| Existing chat    | Math, mentions, code controls, copy/edit, attachments and other preambles remain functional; alternate Markdown renderers degrade predictably                   |
| Context          | Two projects with duplicate IDs, concurrent personas, reload, deleted/conflicting binding metadata and file-browser changes                                     |
| Navigation       | Every supported detail kind; owner/inventory fallback; duplicate opens, related records, unavailable targets, universes and restoration                         |
| Routing          | Two browsers, missing/stale routing, disconnected client and timeout/retry; only the initiating browser acts                                                    |
| Data             | Shared refresh, temporary invalid YAML, missing results, bounded previews, no automatic execution/download; `myst_proto` and current CLI outputs                |
| Packaging/agents | AI present/absent, RTC off/on, non-root base URL, no end-user Node build; deterministic fake-agent CI plus two real ACP adapter smoke tests                     |

The table records the broader acceptance matrix, not a claim that every
combination has been exercised. Automated checks cover core resolution, routing,
streaming, previews, tab reuse, and saved-chat context. Real ACP adapter smoke
tests and optional RTC providers remain manual follow-up checks; no external
model was invoked during implementation. The DOM adapter and alternative
Markdown renderers remain the main compatibility boundary.
