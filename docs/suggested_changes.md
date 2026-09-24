# Suggested changes to other packages

What the workbench needs from the packages it builds on, found while removing
the workarounds it used to carry around the `lc` CLI, git-annex and the agent
harnesses. Each item names the package, what the extension does today, and
what would let it stop.

## lightcone-cli (the engine)

### Ignore `chats/` and `*.chat` in the project template

The workbench stores a project's sessions as Jupyter Chat documents under
`<project>/chats/`. `lc materialize` refuses to start on a dirty tree, so an
open session used to be hidden from `git status` by appending rules to the
repository's `.git/info/exclude`. The extension no longer writes anywhere under
`.git`, so a project with sessions is dirty until its `.gitignore` ignores
them.

Suggested: add to `templates/files/gitignore.tmpl`

```
chats/
*.chat
```

The template already ignores `.lightcone/`, where the extension keeps its
comment store and the project's recorded agent; that entry is what those
stores rely on.

### Expose the bytes of an output at a commit

Every output under `results/` is annexed (`results/** annex.largefiles=anything`
in `gitattributes.tmpl`), so git holds a pointer for each committed version and
git-annex holds the bytes. The record tab's version stepper and **Compare with
previous** need those bytes for an older version. The extension used to spell
git-annex's pointer grammar and run `git annex contentlocation --batch` itself;
it now reads history with dulwich and reports an annexed version as one whose
bytes it cannot serve.

Suggested: a read-only engine API that resolves an output at a commit to its
bytes, or to the path git-annex holds them at, for example

```python
from lightcone.engine import dataset
dataset.read_output(root, "results/<universe>/<output>.png", commit) -> bytes | None
```

or `lc show results/<universe>/<output>.png --at <commit>`. The engine already
owns the git and git-annex seam (`dataset.py`), and it is the one place where
the annex key grammar, `annex.thin` hard links and dropped content are
understood. With that, the version stepper can show and compare older bytes
again.

### Expose run records, not only commit subjects

The engine writes DataLad's `[DATALAD RUNCMD]` record into each
materialization commit (the command, exit code, inputs and outputs). The Run
provenance tab used to parse that record out of `git log`. It now shows the
manifest sidecar's facts only (recipe, tree, engine, environment, inputs by
version), so the executed command line and exit code are no longer shown.

Suggested: record the command (and the exit code, if a failed run can ever be
committed) in the manifest, or provide `lc log --json` listing each
materialization with its command, inputs and outputs. Either removes the last
reason for a consumer to parse commit messages.

### Report when an output was last materialized, in `lc status --json`

`lc status --json` names the commit an output was made at (`git_sha`) but not
when. Home's freshness line ("last materialized 4 days ago") and the "Materialized
during this reply" footer in sessions need a time, which the extension reads
from the commits under `results/` with dulwich.

Suggested: add the commit time (ISO 8601) beside `git_sha` in each
`OutputStatus`, and `lc status` covers the freshness line without any git
reading in the extension.

### Find git-annex beside the engine, not only on `PATH`

`require_git_annex()` probes `PATH`. The git-annex wheel installs its entry
points beside `lc`, but a Jupyter server started without activating that
environment has no such `PATH`, so the extension appends its own
`sysconfig.get_path("scripts")` to `PATH` at load (`projects.expose_engine_tools`).

Suggested: have the engine resolve `git-annex` from the scripts directory of
the interpreter it runs in before falling back to `PATH`, and the extension can
stop editing the server's environment.

### A stable, documented Python API for reads

The extension calls the engine in process for `status`, `converge` and
`project.mode`, and pins `lightcone-cli<0.6` because the engine promises no
stable API. Declaring the read-only surface the extension uses as public
(`materialize.status`, `project.converge`, `project.mode`, and the two reads
suggested above) would let the pin follow semantic versioning.

## jupyter-ai and jupyter-chat

Not covered here: the workarounds around Jupyter AI's persona manager, the
chat widget and the launcher are being reviewed separately.
