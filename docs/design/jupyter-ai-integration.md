# Lightcone Lab: ASTRA chat cards and agent-opened tabs

The open AI-assisted research workbench

Status: implementation updated on 22 September 2026. No upstream or sibling-package changes.

## Decisions

| Decision                  | Implementation                                                                                         | Tradeoff                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Default chat presentation | Persisted `application/vnd.lightcone.astra+json` messages rendered by JupyterLab RenderMime            | Separate cards in the conversation, rather than inline hover links         |
| Inline references         | Deferred; remove the Markdown DOM adapter                                                              | No parser or DOM coupling to stock Markdown or `jupyterlab-myst`           |
| Project context           | The chat's project: where it is stored, else the current project it joined; sessions start at its root | No context text; universes are not selectable from chat yet                |
| Element tabs              | Existing ASTRA UI detail components in native widgets                                                  | Unsupported targets use their owner/inventory or a clear unavailable state |
| Agent access              | Two presentation tools through the existing Jupyter MCP server                                         | Requires the originating browser and a chat with a project                 |

## User experience

The agent calls `lightcone_preview_element(target)` to show a figure,
decision, input, finding, prior insight or analysis directly in chat. The card
uses ASTRA UI's `RecordPreview`, with bounded artifact previews. Click the card
to open its result in a tab, or focus it and press Enter or Space. Embedded links
and controls retain their own actions, and selecting text does not open the card.
The agent can call `lightcone_open_element` to open a tab directly instead.

**Lightcone Agent** uses the native chat icon in Lightcone gold and focuses a
session of the project already open in the main area, or creates one there
(`chats/untitled.chat`), with an empty composer. Outside an ASTRA project, it
shows the same missing-project guidance as the inventory shortcut. Messages
reach the agent exactly as written: there is no context block, message
metadata, or project chip. The agent's session starts at the project root
instead. Chats opened any other way, including Jupyter
Chat's own sidebar and launcher actions, join the current project that the status
bar shows. Existing Jupyter AI model/persona selection continues to work normally.

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

1. Derives the project from the calling chat, then runs the internal
   resolve-preview command in the originating browser, resolving the target and
   universe through the SDK.
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

### Shared path API needed in the SDK

`@astra-spec/sdk` 0.1.2 (the current published release) already handles project
loading, universe resolution and canonical record/analysis indexes. It does not
export a parser for authored references. The remaining MySTRA copy translates
paths such as `analyses.child.outputs.plot` and `decisions.method.options.robust`
into SDK index keys, and identifies child options/evidence for existence checks.
MySTRA itself is a private package distributed as a MyST plugin bundle, so it
cannot currently be used as a normal published npm dependency.

The minimum SDK addition is a browser-safe `parseAstraPath` export and its
`AstraPath` type, plus `canonicalRecordPath` (or an equivalent reference resolver).
It must preserve shorthand/explicit analysis scopes, collection navigation,
option/evidence paths and malformed-path rejection. Both MySTRA and Lightcone
could then import the same implementation. After that SDK release, update the
dependency and remove `src/vendor/mystra-path.ts`, its license, and the packaging
entries. No MyST dependency belongs in this shared parser.

Until that is published, retain only the pure path subset and its attribution;
unused display-text parsing and MyST anchor helpers have been removed. Replacing
it with another local parser would still duplicate the grammar. Accepting only
SDK canonical keys would instead remove existing reference syntax support.

## Project context without modifying Jupyter AI

**The current project.** The workbench has one current project: the one holding
the file browser's folder, found by `findProjectRoot` (the nearest `astra.yaml`
at or above it, never above the Contents drive root). `CurrentProject`
(`src/current-project.ts`, token `ICurrentProject`) is the only place that
computes it. The launcher renders from it, a status bar item names it, and the
browser reports it to `PUT /jupyterlab_lightcone/api/current-project` whenever
it changes and whenever its window regains focus. The server keeps the last
report in memory (`projects.CURRENT_PROJECT` in the web application settings),
so with several windows the one used last decides. Browsing outside every
project reports null; a failed lookup also reports null rather than keep a
stale project. Palette commands still target an explicit argument or the
focused inventory or document before falling back to the file browser folder.

**The chat's project.** Jupyter Chat stores chats where its own entry point
chooses: the sidebar's **+** uses its `defaultDirectory` (the server root by
default), and the launcher and **File › New** use the file browser folder. A
chat may therefore sit outside every project. `projects.chat_project` decides a
chat's project, for both the working directory and the tools, in order:

1. The project storing the chat file: the nearest folder at or above it
   containing `astra.yaml` (`projects.owning_project`). Location always wins,
   so moving a chat into a project changes its project.
2. The project recorded in the chat document's metadata (`lightcone_project`,
   the Contents path of its `astra.yaml`), if that specification still exists.
3. The current project, which is then recorded, so the conversation, its
   agent's working directory and its tools keep that project when the user
   moves on. A missing recorded project is replaced the same way.

Otherwise the chat has no project: its agent keeps Jupyter AI's default folder
and the tools answer `NO_PROJECT`. Nothing is added to messages. The record is
server-side chat metadata, like Jupyter AI's own `acp_session_ids`, so it needs
no client write access to the document and persists in the `.chat` file.

The current project must reach the server before the chat opens: Jupyter AI's
frontend emits `persona_selected` as soon as the chat input mounts, and that
creates the ACP session. The server keeps the last report across page reloads;
only a chat restored in the first moments after a server restart, before the
browser has reported, can miss it. Such a chat, or one opened while no project
is current, joins a project later through its tools, but its live session
keeps its first folder until it is recreated.

**Agent working directory.** Jupyter AI's ACP client passes
`persona.get_chat_dir()` as the `cwd` of `session/new` and `session/load`, and
agents run their shell there regardless of where their process was spawned
(verified with `claude-agent-acp` 0.79: shell commands and `CLAUDE.md` pickup
both follow the session `cwd`). Upstream offers no setting for this directory,
but the manager class is a public trait,
`PersonaManagerExtension.persona_manager_class`. `agent_workspace.PersonaManager`
overrides `get_chat_dir()` to return the chat's project, falling back to the
chat's folder without one. This covers every persona built on the base ACP
client, not only ones we ship. `.jupyter` and workspace discovery also start
from this directory and walk upward, so for a chat inside a project any
`.jupyter` below that project's root, in the chat's own folder or between it and
the root, is no longer found: its MCP servers and local personas silently stop
applying. Conversely, a chat stored at the server root that joins a project
finds that project's `.jupyter` and no longer its own folder's, so MCP
settings kept beside loose chats stop applying to them. Chats the launcher creates sit at the project
root and are unaffected. With no `.jupyter` or `.git` above it, Jupyter AI's
workspace directory, where it saves and relativises attachments, is likewise
the project root.

The walk keeps paths logical rather than resolving symlinks, matching what the
Contents API serves the browser, so a project symlinked out of the server root
(a common JupyterHub home) is owned here exactly as it is in the UI. The routes
that must not be escaped keep using `inside_root`, which still resolves.

`jupyter_server_config.d` is read only for enabling extensions, so the trait
cannot ship as static config. `LightconeApp` sets it on the live
`jupyter_ai_persona_manager` extension app while loading. Managers are created
per chat, after all extensions load, so extension order does not matter. A
deployment that configured its own manager class is left untouched. The subclass
keeps the name `PersonaManager` because Jupyter AI reads `default_persona_id`
from the config section named after the class; another name would silently drop
existing `c.PersonaManager` settings.

An agent that uses Jupyter AI's client-side `terminal/create` without sending a
`cwd` would still inherit the server's directory; agents with native shells
(Claude) are unaffected. A live session keeps its `cwd` until it is recreated.

With the agent already at the project root, per-project guidance belongs in the
project's own `AGENTS.md`/`CLAUDE.md`, which agents load natively and invisibly.

Presentation tools take only the element:

```json
{ "target": "clustering.outputs.xi_multipoles_plot" }
```

The server derives the entrypoint from the calling chat (`X-Jupyter-Chat-Id` →
persona manager → `chat_project`) and passes it to the browser command. The
agent cannot address another project, so no mismatch checks remain.

Paths are rooted at the ASTRA entrypoint and normalized through MySTRA's grammar
and the SDK index, never resolved by display label. Agent calls use the SDK's
automatic universe selection; choosing among multiple universes from chat is not
supported yet. Cards and tabs still record the universe they resolved, and the
browser commands keep their optional `universeId` for direct UI integrations.
If a recorded universe disappears or defaults acquire universe files, show the
context change rather than silently choosing another configuration. Cited papers
open through the browser command's explicit `doi` argument (used by the inventory
and insight views); the agent tools address ASTRA elements only.

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
or the card. Moving a tab also retains it. **Unpin tab** in the toolbar or
**Unpin ASTRA tab** in the context menu/palette makes that tab the reusable preview.
Any other preview in the same group, project and universe is retained as a pin,
so unpinning never discards another result. Focusing an older pinned
tab does not redirect later agent results or make it replaceable. Opens are
serialized, with pin eligibility checked after data resolution.

Use JupyterLab's native tab strip, docking, close controls, and restoration. The
first result may split beside a sufficiently wide source; later results join the
existing result group. There is no nested tab strip. Following a link inside a
record navigates the same tab and extends its history: **Back** and **Forward**
in the record's toolbar (Alt+← and Alt+→) retrace it, and **Open in new tab**
keeps the current record. Preview titles are italic; pinned titles have a pin marker. Pinning retains record
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

The agent reads `astra.yaml` and referenced files through its existing file tools.
Only presentation needs an MCP tool. The internal preview resolver returns the
validated reference and label, without exposing a separate read/context API.

| Tool                                | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `lightcone_preview_element(target)` | Publish an agent-attributed MIME preview in the calling chat |
| `lightcone_open_element(target)`    | Open/focus a native record tab                               |

Jupyter AI is a dependency of the extension. Its Python imports stay lazy so
the inventory, native tabs and the MIME renderer still load if a deployment
removes it. Tools use the existing `jupyter_server_mcp.tools` entrypoint.
Reject missing browser routing before invoking the command bridge, whose default
would broadcast. Never let the model choose a browser ID or a project. Chat IDs
come from MCP request headers, and the project from that chat; a chat without a
project is rejected. Timeouts are
unconfirmed, and retries reuse tabs/cards. Shared-chat clients can naturally see
persisted cards; opening a tab affects only the initiating browser.

## Relationship to the rest of Lightcone

`lightcone-cli` main at `78059fa` produces `results/<universe>/<id>.<format>`,
consistent with the SDK's artifact bindings. Agents can use `lc` and existing
`agent-skills` through their normal terminal/ACP tools. This extension observes
their changes; it adds no execution service. Tool docstrings explain that preview
cards use a tool, even when installed research skills teach MySTRA syntax for
authoring documents. No skill-package change is required.

## Future simplifications

Every workaround this integration carries around Jupyter AI, Jupyter Chat,
JupyterLab and the ASTRA packages, with the narrow upstream change that would
remove it, is kept current in [`docs/workarounds.md`](../workarounds.md); no
upstream PR is planned now.

## Validation boundaries

Automated checks cover MIME validation, origin routing, agent attribution,
repeat-call deduplication, figure and decision cards, tab reuse, persisted-chat
reload, and DOM detach/reconnect cleanup. A browser test keeps a chat in
`chats/` and checks that the message arrives unchanged, the session directory is
the project root under a real Jupyter AI server, and the one-argument tools work.
Another creates a chat at the server root with Jupyter Chat's own command while
the file browser is in a project, and checks that the project's local persona
loads, the session and tools use the project, and the chat keeps it after the
file browser leaves. Browser CI exercises both stock Markdown
and enabled `jupyterlab-myst`. Existing inventory, project/universe, paper and tab
tests remain in place.

The deterministic persona uses the real MCP transport without invoking an external
model. Real ACP adapter smoke tests, RTC providers and non-root base URLs remain
additional manual compatibility checks; passing the fixture does not establish
that every configuration has been exercised.
