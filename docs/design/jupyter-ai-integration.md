# Lightcone Lab: ASTRA chat cards and agent-opened tabs

The open AI-assisted research workbench

Status: implementation updated on 6 September 2026. No upstream or sibling-package changes.

## Decisions

| Decision                  | Implementation                                                                              | Tradeoff                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Default chat presentation | Persisted `application/vnd.lightcone.astra+json` messages rendered by JupyterLab RenderMime | Separate cards in the conversation, rather than inline hover links         |
| Inline references         | Deferred; remove the Markdown DOM adapter                                                   | No parser or DOM coupling to stock Markdown or `jupyterlab-myst`           |
| Project context           | One project and universe/defaults per conversation                                          | Start another discussion to change context                                 |
| Element tabs              | Existing ASTRA UI detail components in native widgets                                       | Unsupported targets use their owner/inventory or a clear unavailable state |
| Agent access              | Four tools through the existing Jupyter MCP server                                          | Requires the originating browser and a bound discussion                    |

## User experience

The agent calls `lightcone_preview_element(entrypoint, target)` to show a figure,
decision, input, finding, prior insight or analysis directly in chat. The card
uses ASTRA UI's `RecordPreview`, with bounded artifact previews and **Open in tab**.
The agent can call `lightcone_open_element` to open a tab directly instead.

**Agentic assistant** uses the native chat icon and opens a bound conversation in
the left Jupyter Chat sidebar, with visible tool guidance. Outside an ASTRA project,
it shows the same missing-project guidance as the inventory shortcut.
**Add to chat** inserts a target into the editable composer, without sending it.
The project chip identifies the binding. Existing Jupyter AI model/persona selection
continues to work normally.

Cards persist in `.chat` files but display current project data, not a historical
snapshot. Each identifies its project, target and universe. Missing results stay
unavailable; transient invalid edits retain the last valid data with a notice.
Nothing runs recipes or downloads papers automatically. No MyST/theme server is needed.

## MIME rendering and message delivery

Jupyter AI 3.2 uses Jupyter Chat 0.25. Chat accepts `mime_model` messages and picks
one safe representation through its RenderMime registry. Register the ASTRA MIME
factory at rank 40, ahead of the text fallback. A card stores only:

```json
{
  "version": 1,
  "entrypoint": "myst_proto/astra.yaml",
  "target": "outputs.bao_fit_plot",
  "universeId": "baseline"
}
```

`null` explicitly pins defaults when there are no root universe files. Validate
the version, Contents path, target and universe before loading anything. Ignore
unrelated fields; do not accept HTML, scripts or artifact URLs from the payload.
The shared SDK resolver and authenticated Contents service supply project data.
The bundle also includes `text/plain` and a readable message body for clients
without this renderer. MIME cards work independently of whichever extension
renders `text/markdown`.

The ACP client's ordinary response stream is text; merely returning MIME JSON
from a tool does not insert a rich chat message. The preview tool therefore:

1. Runs the existing read-element command in the originating browser, validating
   the chat binding and resolving the target and universe through the SDK.
2. Looks up the calling persona using the same chat/persona headers and server
   registry as Jupyter MCP routing, and verifies its processing-message browser.
3. Publishes `NewMessage(..., mime_model=MimeModel(...))` through that persona's
   chat model. This preserves agent attribution and does not send a human prompt.
4. Returns the message ID. The same persona, target and universe within one prompt
   reuse an existing non-deleted card, making retries safe. A later prompt can
   show a new card.

This persona lookup is a small compatibility adapter targeting Jupyter AI 3.2;
there is currently no public rich-message tool API. The tool reuses frontend
resolution rather than duplicating ASTRA business logic in Python.
[Routing registry](https://github.com/jupyter-ai-contrib/jupyter-server-mcp/blob/92f0c7b9b98dd1c796dae469ff50a4edd9cb9083/jupyter_server_mcp/client_routing.py).

Jupyter Chat 0.25 inserts the MIME renderer's DOM node but does not dispose its
widget. Our renderer uses a custom element's connection/disconnection callbacks
to mount and unmount React. That releases project leases, theme signals and
artifact effects when messages are removed or chats close; moving/reconnecting
a card remains supported. Normal Lumino widget disposal is handled too.
[Chat renderer](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/components/messages/message-renderer.tsx).

## Why inline references are deferred

The stock Markdown renderer preserves `{astra}` followed by code; MyST consumes
unknown roles before our former adapter can see their markers. Jupyter Chat has
no public message-body parsing/decorating hook, and `jupyterlab-myst` hardcodes
its role/transform/React renderer lists. Supporting both would require additional
private integration or owning the Markdown pipeline. Per the agreed scope,
remove the inline parser, DOM matching and hover adapter. Ordinary text remains
owned by the installed Markdown renderer; tools and MIME cards remain functional.
[MyST parser](https://github.com/jupyter-book/jupyterlab-myst/blob/402964a9b28d9dd7b617a125a22372d37359a5a2/src/myst.ts).

Keep only MySTRA's vendored pure path parser for canonical element addresses,
with its license and source revision. No build-time MyST plugin is bundled.

## Project context without modifying Jupyter AI

Bind a **new** Lightcone conversation to one entrypoint and universe/defaults
context. Persist a versioned `lightcone` context object in the first sent user
message's metadata, and repeat it on subsequent outgoing messages using the
existing `input.getMetadata()` / `input.updateMetadata()` mechanism. Include a short visible context block so the
agent receives the project and reference instructions too: metadata alone is not
part of its prompt.
[Message metadata](https://github.com/jupyterlab/jupyter-chat/blob/6081b7d6eaa8249171ba9be6bc51b287e131ab8b/packages/jupyter-chat/src/types.ts).

On reload, derive the binding from the chat's persisted context messages. Keep it
fixed for that conversation. Switching files changes neither saved cards nor
in-flight responses; discussing another project or universe starts another chat.
All personas in the chat therefore interpret rooted MySTRA paths consistently,
even though current ACP replies do not inherit our metadata.

Do not retroactively enrich an existing unbound history based on the current file
browser. If binding metadata is missing or conflicting, show the context problem
and reject agent commands. Repeating metadata makes deletion of the first
message recoverable, but deleting all binding messages loses that context. This
is simpler than server monkey-patching or inferring reply parents from timing.

Use the same validated target for cards and commands:

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
context; child navigation reuses the owner tab. Each result group reuses its
unpinned ASTRA preview. Pinning promotes the preview to a retained view; subsequent
opens use a different preview in that group. Pins are explicit through the toolbar,
native tab context menu, command palette, or double-clicking the native tab label
or card's Open in tab button. Moving a tab also retains it. Focusing an older pinned
tab does not redirect later agent results or make it replaceable. Opens are
serialized, with pin eligibility checked after data resolution.

Use JupyterLab's native tab strip, docking, close controls, and restoration. The
first result may split beside a sufficiently wide source; later results join the
existing result group. There is no nested tab strip or Back/Forward navigation.
Preview titles are italic; pinned titles have a pin marker. Pinning retains record
identity, not a snapshot. Save the current reference and pin state under a stable
widget ID, so replacing a preview does not leave old records in the workspace.
Restoration does not require a readable project: removed records show an unavailable
state, and project loading errors can recover through the shared data service.

JupyterLab and Lumino do not provide a public preview/pinning API:
[JupyterLab #5745](https://github.com/jupyterlab/jupyterlab/issues/5745) and
[Lumino #498](https://github.com/jupyterlab/lumino/issues/498).
The adapter uses the public shell tab-bar API and native title metadata; it can be
replaced when core provides this behavior. Native tab-title editing takes precedence
over double-click pinning when a host enables it.

Use shared ASTRA headers, details, and actions with a compact project/analysis/universe
toolbar. Decisions and other reading views have a bounded column. Figures and tables
use the available width with provenance beside them, stacking in narrow panels.
Cited papers use the shared reader and can locate the originating insight's quote.
Show project/scope in captions to distinguish identical labels.

Extend the existing shared project service's entrypoint key with resolution
context where needed; do not add per-card polling. Jupyter Live Content does not
currently manage arbitrary third-party views, so keep our subscription lifecycle.
[Live Content scope](https://github.com/jupyter-ai-contrib/jupyter-live-content/blob/6073133dde634ffb26213ef4004cc7a5d70fa377/README.md).

### Tools and transport

| Tool                                                             | Purpose                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `lightcone_project_context(entrypoint?, query?, offset?)`        | Bound project, capabilities and paginated searchable targets |
| `lightcone_read_element(entrypoint, target?, universeId?, doi?)` | Bounded details, relationships and artifact availability     |
| `lightcone_preview_element(entrypoint, target)`                  | Publish an agent-attributed MIME preview in the bound chat   |
| `lightcone_open_element(entrypoint, target?, universeId?, doi?)` | Open/focus a native record or cited-paper tab                |

Python imports are lazy so inventory, native tabs and the MIME renderer work
without Jupyter AI. Tools use the existing `jupyter_server_mcp.tools` entrypoint.
Reject missing browser routing before invoking the command bridge, whose default
would broadcast. Never let the model choose a browser ID. Chat IDs come from MCP
request headers; project and universe mismatches are rejected. Timeouts are
unconfirmed, and retries reuse tabs/cards. Shared-chat clients can naturally see
persisted cards; opening a tab affects only the initiating browser.

## Relationship to the rest of Lightcone

`lightcone-cli` main at `78059fa` produces `results/<universe>/<id>.<format>`,
consistent with the SDK's artifact bindings. Agents can use `lc` and existing
`agent-skills` through their normal terminal/ACP tools. This extension observes
their changes; it adds no execution service. Tool docstrings and the prepared
prompt explain that preview cards use a tool, even when installed research skills
teach MySTRA syntax for authoring documents. No skill-package change is required.

## Future simplifications

These are optional follow-ups, with no upstream PR planned now:

- Jupyter AI's public rich-message publishing API could replace persona-registry access.
- Correct MIME-widget disposal in Chat could remove our custom-element lifecycle adapter.
- A shared message-body/role extension API with explicit project context could make inline references practical.
- A browser-safe MySTRA parser package could replace the vendored grammar.
- Workbench guidance in `agent-skills` could reduce repeated onboarding instructions.

## Validation boundaries

Automated checks cover MIME validation, origin routing, agent attribution,
repeat-call deduplication, figure and decision cards, tab reuse, persisted-chat
reload, and DOM detach/reconnect cleanup. Browser CI exercises both stock Markdown
and enabled `jupyterlab-myst`. Existing inventory, project/universe, paper and tab
tests remain in place. Build and packaging checks retain optional AI dependencies.

The deterministic persona uses the real MCP transport without invoking an external
model. Real ACP adapter smoke tests, RTC providers and non-root base URLs remain
additional manual compatibility checks; passing the fixture does not establish
that every configuration has been exercised.
