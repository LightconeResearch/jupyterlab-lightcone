# Compute clusters: design and engine contract

|                   |                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Status**        | Proposed. The JupyterLab half is implemented; the lightcone-cli half is specified here.                         |
| **Scope**         | `jupyterlab-lightcone` (Compute section, cluster registry writer) and `lightcone-cli` (registry reader, attach) |
| **Record format** | `lightcone.cluster/1`                                                                                           |
| **Audience**      | Maintainers of both packages, site administrators (NERSC, JupyterHub deployments)                               |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY in sections 6, 8 and 9
are to be read as described in RFC 2119. They bind the two implementations to
each other; everything else in this document explains them.

---

## 1. Summary

The Lightcone sidebar gains a **Compute** section from which a user starts,
watches and stops a Dask cluster on the infrastructure their Jupyter server
runs on:

| Where Jupyter runs                      | Cluster the section starts                                           |
| --------------------------------------- | -------------------------------------------------------------------- |
| A workstation or laptop                 | A local scheduler and worker, supervised by the Jupyter server       |
| A JupyterHub on Kubernetes              | A Dask Gateway cluster, authenticated through JupyterHub             |
| A Slurm system such as NERSC Perlmutter | One Slurm job: a scheduler on its first node and one worker per node |

Every cluster is recorded in a per-user registry, `~/.lightcone/clusters/`.
`lc materialize` reads that registry, attaches to the cluster the project may
use, and runs its task graph there instead of starting a cluster of its own.
The registry is the whole interface between the two packages: the extension
is its only writer, the engine only reads it, and neither calls the other.

The same interface and the same file layout serve all three environments, so
the UI looks and behaves the same everywhere; what differs is the backend
behind it.

## 2. Goals and non-goals

**Goals**

1. Start compute from the sidebar ahead of a run, so that repeated runs (an
   agent iterating on an analysis) do not each pay for queue waits or pod
   start-up.
2. Let `lc materialize` find that compute on its own, from any process: the
   Runs panel, a JupyterLab terminal, an agent's shell, an SSH session.
3. One interface for a workstation, a JupyterHub on Kubernetes and a Slurm
   system.
4. Show, at all times, where the current project's runs will execute and
   whether that place can run them.
5. Keep clusters authenticated and private to their owner.

**Non-goals**

- Scheduling a project's work across several clusters, or sharing a cluster
  between users.
- Replacing the engine's own venues. Inside a Slurm allocation the engine
  keeps spanning the allocation; with no cluster, it keeps running locally.
- Making every Dask deployment tool (dask-labextension, dask-ctl, ipyparallel)
  interoperate. The registry borrows their good ideas (section 17) but serves
  Lightcone runs only.
- Containerized projects on Dask Gateway (section 9.10 and 16).

## 3. Background

### 3.1 How the engine executes today

`lc materialize` builds the analysis as a graph of tasks and hands each task
to a Dask scheduler through a narrow seam, `materialize.cluster_for_run()`,
which only ever needs `submit(fn, *args, key=…)` and `as_completed(…)`. That
function is the engine's whole _venue ladder_:

1. inside a Slurm allocation (`SLURM_JOB_ID` set), a scheduler in the driver
   plus one worker per allocated node started with a single `srun`
   (`venue.slurm_client()`);
2. anywhere else, a threaded `LocalCluster` using every core.

Venues are detected, never configured. A worker needs `lightcone.engine`
importable at the driver's version (task functions and results are pickled by
reference), the project tree at the same absolute path, and, for
containerized projects, a container runtime on its host. Workers never run
git or git-annex; the driver alone commits. Recipes run in subprocesses
behind the engine's sandbox, which is why workers are started with one
process per host, as many threads as cores, no nanny and no memory limit.

### 3.2 Why a cluster that outlives a run

A cluster per run is right on a workstation and wasteful elsewhere:

- On a Slurm system every run is a new job. A debug or interactive QOS job
  typically waits minutes; a regular job can wait hours. An agent that
  re-runs `lc materialize` after each edit pays that wait every time.
- On Kubernetes every run pulls images and schedules pods, a minute or more
  before the first task.

A cluster the user starts once, and that stops when idle or at its time limit,
removes that cost without changing what a run is.

### 3.3 History

The engine previously integrated Dask Gateway twice: first attaching to a
cluster the user had started, then creating one cluster per run, before the
integration was removed in the engine rebuild. This design returns to
attaching, with three differences that address why attaching was dropped:
the cluster is visible and controllable in the UI (it is never a forgotten
background resource), the registry makes attaching explicit and verifiable
(the engine refuses rather than silently using an incompatible cluster), and
it serves Slurm systems and workstations as well as Kubernetes.

## 4. Concepts

**Target.** A place runs can go. There is always one _host target_ (this
Jupyter server's host, which is a workstation, a JupyterHub server pod, a
login node or a Slurm allocation) and zero or more _cluster targets_.

**Cluster.** A Dask scheduler with workers, started by the extension on a
_backend_: `local`, `slurm` or `gateway`. Clusters belong to the user, not to a
project: one cluster serves every project that can use it.

**Record.** The registry entry for a cluster: how to reach it, what its
workers run, and the backend handle (process ids, Slurm job id, Gateway
cluster name).

**Environment.** What a cluster's workers run: an interpreter with a given
`lightcone-cli` and `distributed`, and on Gateway a container image. A project
can use a cluster only if the environments match (section 8.3).

**Active target.** The target `lc materialize` would use for the current
project right now. Exactly one target is active.

## 5. Architecture

```
 Browser                          Jupyter server (extension)                 Backends
┌──────────────────┐  REST  ┌─────────────────────────────────┐   ┌──────────────────────────┐
│ Sidebar ▸ Compute├───────►│ ComputeService                  │──►│ local: two process groups │
│ rows, menus,     │        │  listing: records ⋈ backend     │──►│ slurm: sbatch / squeue /  │
│ presets, dialogs │◄───────┤  status, active target          │   │        scancel / sacct    │
└──────────────────┘        │  create / stop                  │──►│ gateway: Gateway REST API │
                            └───────────────┬─────────────────┘   └──────────────────────────┘
                                            │ writes (only writer)
                                            ▼
                              ~/.lightcone/clusters/<id>/cluster.json, tls/, scheduler.json
                                            ▲
                                            │ reads (only reader)
                            ┌───────────────┴─────────────────┐
                            │ lc materialize (driver)         │── Dask client ──► scheduler
                            │  allocation ▸ attached ▸ local  │                    + workers
                            └─────────────────────────────────┘
```

The extension never starts `lc`, and `lc` never starts or stops a cluster.
A run started from the Runs panel and one started by an agent in a terminal
find the same cluster in the same way.

Implementation map (this repository):

| Path                                      | Role                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `jupyterlab_lightcone/compute/records.py` | Registry layout, record I/O, TLS material, scheduler and worker command lines |
| `jupyterlab_lightcone/compute/local.py`   | Local backend                                                                 |
| `jupyterlab_lightcone/compute/slurm.py`   | Slurm backend and job script                                                  |
| `jupyterlab_lightcone/compute/gateway.py` | Dask Gateway backend                                                          |
| `jupyterlab_lightcone/compute/service.py` | Reconciliation, host target, selection, create and stop                       |
| `jupyterlab_lightcone/compute/routes.py`  | HTTP API                                                                      |
| `src/compute/`                            | Compute section, model, presets, menus, Custom… dialog                        |
| `schema/compute.json`                     | Preset settings                                                               |

## 6. The cluster registry

This section is normative for both packages.

### 6.1 Location and permissions

- The registry root is `~/.lightcone/clusters/`, where `~` is the home
  directory of the user who owns the Jupyter server. It is per user and lives
  on the filesystem every node of the site sees (the home filesystem at NERSC;
  the NFS home mounted into server and worker pods on the Lightcone hub).
- The writer MUST create the root and every cluster directory with mode
  `0700`, and every file it writes with mode `0600`.
- Readers MUST NOT follow a cluster directory that is not named by a cluster
  id (`YYYYMMDD-HHMMSS-xxxx`, UTC creation time and four characters from
  `[a-z0-9]`), and MUST skip entries they cannot read or parse.

### 6.2 Directory layout

```
~/.lightcone/clusters/
└── 20260924-141502-k3x9/
    ├── cluster.json        # the record (section 6.3); written by the extension
    ├── tls/
    │   ├── cert.pem        # self-signed certificate, also the CA (local, slurm)
    │   └── key.pem         # its private key
    ├── scheduler.json      # Dask's own scheduler file, written by the scheduler (local, slurm)
    ├── job.sh              # the batch script (slurm)
    ├── slurm-<job>.out     # the job's output (slurm)
    ├── scheduler.log       # the scheduler's output (local)
    └── worker.log          # the worker's output (local)
```

`scheduler.json` is the file the Dask scheduler writes when started with
`--scheduler-file`; it appears once the scheduler listens and disappears when
it closes cleanly. It is Dask's format, not Lightcone's: its `address` field
is the one readers connect to, and `services.dashboard` is the dashboard port.

### 6.3 The record, `cluster.json`

| Field     | Type                                  | Meaning                                                                                                                                                                                                                                               |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`  | string                                | `"lightcone.cluster/1"`. Readers MUST ignore records of any other value.                                                                                                                                                                              |
| `id`      | string                                | The cluster id; equals the directory name.                                                                                                                                                                                                            |
| `backend` | `"local"` \| `"slurm"` \| `"gateway"` | Which backend runs the cluster.                                                                                                                                                                                                                       |
| `label`   | string                                | The preset's name, shown to the user.                                                                                                                                                                                                                 |
| `created` | string                                | Creation time, RFC 3339 UTC (`2026-09-24T14:15:02Z`).                                                                                                                                                                                                 |
| `host`    | string                                | Host name of the Jupyter server that created the cluster.                                                                                                                                                                                             |
| `tls`     | object \| null                        | Paths, relative to the cluster directory, of the TLS material: `ca`, `cert`, `key`. Null for Gateway clusters, whose credentials the gateway serves.                                                                                                  |
| `workers` | object                                | What workers run: `interpreter` (absolute path, or null on Gateway), `image` (container image, or null for host-level clusters), `lightcone` (the `lightcone-cli` version), `distributed` (the `distributed` version), `python` (the Python version). |
| `local`   | object                                | Local backend only: `host`, `pid` (scheduler), `worker` (worker), `threads`.                                                                                                                                                                          |
| `slurm`   | object                                | Slurm backend only: `job` (job id), `nodes`, `time`, and `qos`, `constraint`, `account` when set.                                                                                                                                                     |
| `gateway` | object                                | Gateway backend only: `name` (Gateway cluster name), `address` (Gateway API address), `workers` (adaptive maximum), and `cores`, `memory` when set.                                                                                                   |

Examples:

```json
{
  "format": "lightcone.cluster/1",
  "id": "20260924-141502-k3x9",
  "backend": "slurm",
  "label": "Regular · 4 nodes · 2 h",
  "created": "2026-09-24T14:15:02Z",
  "host": "login23",
  "tls": { "ca": "tls/cert.pem", "cert": "tls/cert.pem", "key": "tls/key.pem" },
  "workers": {
    "interpreter": "/global/common/software/m1234/lightcone/bin/python",
    "image": null,
    "lightcone": "0.5.0",
    "distributed": "2026.8.0",
    "python": "3.13.12"
  },
  "slurm": {
    "job": "31415926",
    "nodes": 4,
    "time": "2:00:00",
    "qos": "regular",
    "constraint": "cpu"
  }
}
```

```json
{
  "format": "lightcone.cluster/1",
  "id": "20260924-093011-a7q2",
  "backend": "gateway",
  "label": "Medium",
  "created": "2026-09-24T09:30:11Z",
  "host": "jupyter-someone",
  "tls": null,
  "workers": {
    "interpreter": null,
    "image": "ghcr.io/lightconeresearch/lightcone-hub/user:sha-3f9c1e2",
    "lightcone": "0.5.0",
    "distributed": "2026.8.0",
    "python": "3.13.12"
  },
  "gateway": {
    "name": "lightcone.0123abcd",
    "address": "http://traefik-lightcone-dask-gateway/services/dask-gateway",
    "workers": 6,
    "cores": 2,
    "memory": 4
  }
}
```

Readers MUST ignore fields they do not know. The writer MAY add fields
without changing `format`; removing or changing the meaning of a field
requires a new format string.

### 6.4 Write protocol

- The extension is the only writer. The engine MUST NOT create, modify or
  delete anything under the registry root.
- Every write of `cluster.json` is atomic: a temporary file in the same
  directory, then `rename`. A reader never sees half a record.
- The record is written **before** the backend starts anything, then rewritten
  with the backend handle once the backend accepts the cluster. A failed start
  removes the directory. A reader can therefore meet a record without a handle
  (section 6.5).
- The extension removes a cluster's directory once the cluster's backend
  reports it gone. Readers MUST tolerate a directory disappearing between
  listing and reading it.

### 6.5 Source of truth

Two facts, two owners:

- **Whether a cluster exists, and its state**, belongs to the backend: the
  scheduler process on this host, the Slurm controller, the Gateway.
- **How to reach it and what it runs** belongs to the record.

Every reader joins the two. A record whose backend reports the cluster gone
is dead. A record whose backend cannot be asked (a Slurm controller outage, an
unreachable gateway) is of **unknown** state, and MUST NOT be treated as gone:
an outage must never orphan a running cluster. A record without a backend
handle is starting if younger than two minutes and dead otherwise.

### 6.6 Compatibility handshake

The engine announces the record format it reads with a module constant:

```python
# lightcone/engine/venue.py
CLUSTER_RECORD_FORMAT = "lightcone.cluster/1"
```

The extension compares it with the format it writes. When they differ (an
engine that predates this design, or a future format), the Compute section
still manages clusters, marks the host target active, and says that the
installed `lightcone-cli` does not run on clusters yet. Neither package probes
the other any other way.

## 7. Backends

All three backends run the same scheduler and worker processes where they
start them themselves, with command lines built in one place
(`records.scheduler_argv`, `records.worker_arguments`):

```
python -m distributed.cli.dask_scheduler --scheduler-file <dir>/scheduler.json \
    --host <host> --port 0 --protocol tls --dashboard-address <host>:0 \
    --idle-timeout <seconds>s --tls-ca-file … --tls-cert … --tls-key …

python -m distributed.cli.dask_worker --scheduler-file <dir>/scheduler.json \
    --protocol tls --nworkers 1 --no-nanny --no-dashboard --memory-limit 0 \
    --death-timeout 60 --local-directory /tmp --nthreads <cores> \
    --tls-ca-file … --tls-cert … --tls-key …
```

`python` is the Jupyter server's interpreter, which imports the same
`lightcone.engine` the server itself uses. Every process runs with
`DASK_DISTRIBUTED__COMM__REQUIRE_ENCRYPTION=True`. The worker flags are the
engine's own worker contract (section 3.1). The scheduler's idle timeout is
`c.LightconeApp.cluster_idle_timeout`, 1800 seconds by default.

### 7.1 Local

- Scheduler and worker are two processes, each in a session of its own,
  bound to `127.0.0.1`. The record keeps both process ids.
- _State_: running when the scheduler process is alive and `scheduler.json`
  exists; starting while it is alive without it; gone when it is dead. Where
  `/proc` exists, a reused process id is told from the scheduler by its
  command line. A record from another host is of unknown state from here.
- _Lifetime_: until **Stop**, until the Jupyter server shuts down cleanly
  (the extension stops the clusters it launched), or until the scheduler's
  idle timeout if the server dies.
- Offered only where a preset asks for it, and never on a known HPC center's
  login node. On a workstation the engine already uses every core without a
  cluster, so a local cluster mainly buys warm workers and a dashboard.

### 7.2 Slurm

- One `sbatch` job, submitted from the Jupyter server's host, running
  `job.sh`:

  ```bash
  #!/bin/bash
  #SBATCH --job-name=lightcone-<id>
  #SBATCH --nodes=<nodes>
  #SBATCH --time=<time>
  #SBATCH --output=slurm-%j.out
  #SBATCH --qos=<qos>                # when the preset sets it
  #SBATCH --constraint=<constraint>  # when the preset sets it
  #SBATCH --account=<account>        # when the preset sets it
  set -u
  export DASK_DISTRIBUTED__COMM__REQUIRE_ENCRYPTION=True
  unset SLURM_CPUS_PER_TASK SLURM_TRES_PER_TASK
  host="${SLURMD_NODENAME:-$(hostname)}"
  cpus="${SLURM_CPUS_ON_NODE:-$(nproc)}"
  <python> -m distributed.cli.dask_scheduler … --host "$host" --dashboard-address "$host:0" &
  scheduler=$!
  srun --overlap --ntasks="$SLURM_JOB_NUM_NODES" --ntasks-per-node=1 \
       --cpus-per-task="$cpus" <python> -m distributed.cli.dask_worker … --nthreads "$cpus" &
  workers=$!
  wait -n
  kill "$scheduler" "$workers" 2>/dev/null
  wait
  ```

  The scheduler binds the node's Slurm name, as the engine's allocation venue
  does; the worker step mirrors the engine's own `srun` flags. When either
  half ends, the job ends.

- _State_, from `squeue --me`: `PENDING` is queued (with Slurm's start
  estimate when it has one); `RUNNING` or `CONFIGURING` is starting until
  `scheduler.json` exists, then running; any other state is stopping; a job
  absent from the queue is gone, and `sacct`, where the site keeps it, says
  why (`TIMEOUT`: "reached its time limit", `CANCELLED`, `FAILED`,
  `NODE_FAIL`, …).
- _Lifetime_: independent of Jupyter. The job ends at its time limit, when the
  scheduler has been idle for the idle timeout, or on **Stop** (`scancel`).
- Presets set `nodes`, `time`, `qos`, `constraint` and `account`; the account
  defaults to the user's Slurm default. Values are copied into `#SBATCH` lines,
  so they are validated against strict patterns: no whitespace, quotes,
  newlines or shell metacharacters reach the script.
- NERSC's `interactive` QOS accepts only `salloc`, so it cannot back a
  cluster submitted with `sbatch`; `debug`, `regular`, `shared` and `preempt`
  can. The `jupyter` QOS that JupyterHub uses for compute-node servers is
  reserved for them, so no preset should name it.

### 7.3 Dask Gateway

- Used when the `dask_gateway` client is installed and `gateway.address` is
  configured (`DASK_GATEWAY__ADDRESS`), as on a daskhub-style JupyterHub.
  Authentication is the gateway's own (JupyterHub tokens on the Lightcone hub).
- The extension asks for the gateway's cluster options and sets, where the
  deployment offers them: `image` to the server's own image
  (`JUPYTER_IMAGE_SPEC`), `worker_cores` and `worker_memory` from the preset,
  and `environment` extended with `LIGHTCONE_CLUSTER=<id>`. A preset field the
  deployment has no option for is refused rather than dropped. The cluster is
  submitted, then made adaptive between **one** worker (the worker the engine
  verifies on attach, section 9.3) and the preset's `workers`.
- _State_, from `Gateway.list_clusters()`: `PENDING` is starting, `RUNNING` is
  running, `STOPPING` is stopping, absent is gone (`get_cluster` then says
  whether it was stopped or failed). A record naming another gateway is of
  unknown state.
- _Lifetime_: the gateway's; its own idle timeout culls idle clusters (30
  minutes on the Lightcone hub), and **Stop** calls `stop_cluster`.
- The gateway publishes the dashboard link; TLS credentials come from the
  gateway on connect, so the record holds none.

### 7.4 Comparison

|                            | Local                            | Slurm                                                           | Dask Gateway                  |
| -------------------------- | -------------------------------- | --------------------------------------------------------------- | ----------------------------- |
| Scheduler runs             | On the Jupyter host, loopback    | On the job's first node                                         | In a scheduler pod            |
| Workers                    | One, on the Jupyter host         | One per node                                                    | Adaptive, 1 to `workers` pods |
| Survives a Jupyter restart | No (clean shutdown stops it)     | Yes                                                             | Yes                           |
| Ends                       | Stop, shutdown, idle timeout     | Stop, time limit, idle timeout                                  | Stop, gateway idle timeout    |
| Authentication             | Per-cluster TLS                  | Per-cluster TLS                                                 | Gateway TLS and JupyterHub    |
| Environment                | Server's interpreter             | Server's interpreter (shared filesystem)                        | Server's image                |
| Containerized projects     | Yes (container runtime per task) | Yes (podman-hpc across nodes)                                   | Not yet (section 9.10)        |
| Dashboard                  | Through `jupyter-server-proxy`   | Through `jupyter-server-proxy`, if the site allows remote hosts | Gateway's link                |

## 8. Selection: which target a run uses

This section is normative for the engine. The extension implements the same
rule to mark the active target (`service.py`); once the engine exposes it
(section 9.2), the extension calls the engine instead.

### 8.1 The ladder

For a project at `root`, `cluster_for_run()` MUST choose, in order:

1. **The allocation**, when `SLURM_JOB_ID` is set. Clusters in the registry are
   ignored: a process inside an allocation (a batch job, an `salloc` shell, a
   compute-node Jupyter server) spans that allocation, as today.
2. **The attached cluster**, when exactly one cluster is a candidate
   (section 8.2).
3. **This host**, otherwise, with the engine's existing login-node guard.

The allocation comes first because it is the most specific fact available: a
process running inside a job was put there on purpose, and a batch job that
wandered onto a cluster held by an interactive session would be surprising.

### 8.2 Candidates

A record is a candidate for the project when all of these hold:

1. `format` is the engine's `CLUSTER_RECORD_FORMAT`.
2. It is reachable from here:
   - `local`: `local.host` equals this host's name;
   - `slurm`: always (the registry and the compute nodes are shared);
   - `gateway`: `gateway.address` equals the gateway address this process is
     configured with.
3. Its backend reports it queued, starting or running (section 6.5; not
   stopping, not gone, not unknown).
4. Its environment is compatible with the project (section 8.3).

If more than one record is a candidate, the engine MUST refuse and name them
all, rather than choose. The extension never starts a second cluster on the
same backend for the same environment, so this happens only if clusters were
started by other means.

### 8.3 Environment compatibility

- A record with `workers.image` null is a host-level cluster (local, Slurm):
  it is compatible with every project. Containerized projects run each recipe
  in the project's image through the worker host's container runtime, as they
  do today.
- A Gateway record is compatible with a **direct-mode** project when
  `workers.image` equals the image the engine itself runs in
  (`JUPYTER_IMAGE_SPEC`). It is never compatible with a containerized project
  in this version (section 9.10).

A record whose image is incompatible is simply not a candidate: it serves
other projects, and the Compute section shows it as "another image".

### 8.4 Refusals on attach

Having chosen a cluster, the engine MUST NOT fall back to another target when
it cannot use it; it MUST refuse, naming the cluster and the remedy:

| Situation                                                                            | Refusal                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Queued                                                                               | The cluster is queued, with Slurm's start estimate; run again once it starts.                            |
| Starting beyond the wait (section 9.5)                                               | The cluster did not start in time; check its log (`slurm-<job>.out`, `scheduler.log`).                   |
| `workers.lightcone` differs from the engine's version, or the probe finds a mismatch | Workers run lightcone-cli X, this is Y; **Replace** the cluster from the Compute section.                |
| The project root is not visible on a worker                                          | The project is not on a filesystem the workers see; move it (e.g. to `$SCRATCH` or the home filesystem). |
| TLS or connection failure                                                            | The cluster could not be reached; stop it from the Compute section.                                      |
| Several candidates                                                                   | Several clusters could run this project: list them; stop all but one.                                    |

## 9. What lightcone-cli must change

This section is normative. It lists every engine change the design needs;
none of them exists yet.

### 9.1 Announce the format

`lightcone.engine.venue` MUST define `CLUSTER_RECORD_FORMAT =
"lightcone.cluster/1"` in the release that implements sections 8 and 9, and
not before.

### 9.2 Discover and attach

`venue` SHOULD expose the selection as one function, used by
`cluster_for_run()` and callable by the extension:

```python
def attached_cluster(root: Path) -> Record | None:
    """The one registry record this project's runs attach to, or None.

    Raises ProjectError for the refusals of section 8.4.
    """
```

Attaching, for host-level clusters:

```python
from distributed import Client, Security

tls = record["tls"]
directory = registry_root / record["id"]
security = Security(
    tls_ca_file=str(directory / tls["ca"]),
    tls_client_cert=str(directory / tls["cert"]),
    tls_client_key=str(directory / tls["key"]),
    require_encryption=True,
)
client = Client(scheduler_file=str(directory / "scheduler.json"), security=security, timeout=30)
```

The engine MUST check that `scheduler.json` exists before calling `Client`
(Dask waits forever for a missing scheduler file) and MUST pass a timeout.
For Gateway clusters, `dask_gateway.Gateway().connect(record["gateway"]["name"])`
returns a cluster whose `get_client()` carries the gateway's credentials;
`dask-gateway` becomes an optional dependency of the engine.

The extension's test suite pins that this recipe works: a separate process
attaches to a local cluster using nothing but the record and runs a task
(`test_compute_local.py`).

### 9.3 Verify on attach

Before submitting anything, the engine MUST run a probe on every worker with
`client.run`, comparing each worker's `lightcone-cli`, `distributed` and Python
versions with its own, and checking that the project root exists there. Any
mismatch is a refusal (section 8.4). Dask itself only warns on version
mismatches; the engine's pickled task functions need an identical engine.

### 9.4 Run-scoped task keys

Task keys are `universe/output` today, which is safe only while each run has
its own scheduler. On a shared scheduler, two projects (or two clones of one
project) with the same output name would receive each other's results, since
Dask treats equal keys as the same task. The engine MUST key tasks as:

```
lc/<project>/<run>/<universe>/<output>
```

where `<project>` is the project's name and `<run>` a random id per
invocation. The prefix also lets the Compute section, later, split a
cluster's load by project.

### 9.5 Waiting and teardown

- On an attached cluster the engine MUST wait for at least one worker, not for
  a fixed count (a Gateway cluster adapts; a Slurm cluster's workers are
  already up), with a bounded wait comparable to today's 120 seconds.
- It MUST NOT retire workers or close the cluster when the run ends; it
  closes its client only. Retiring is correct only for clusters the engine
  started itself.

### 9.6 The login-node guard

`venue.require_compute_node()` refuses to run recipes on a known center's
login node. With an attached Slurm or Gateway cluster, recipes run on the
cluster's workers and the driver only coordinates and commits, so the guard
MUST NOT refuse in that case. With no cluster, it refuses as today, and its
remedy SHOULD also name the Compute section.

### 9.7 Say where the run executed

The engine today speaks about its venue only when it refuses. With clusters
that outlive runs, silently attaching to a forgotten cluster (possibly
spending allocation hours) is the failure to avoid, so:

- the `--json` report MUST gain a `venue` object, e.g.
  `{"kind": "cluster", "backend": "slurm", "id": "…", "label": "…"}` or
  `{"kind": "allocation", "nodes": 4}` or `{"kind": "local"}`;
- the human output SHOULD begin with one line naming it, e.g.
  `· on the Slurm cluster from the Lightcone sidebar — job 31415926, 4 nodes`.

### 9.8 The recipe environment on long-lived workers

Recipes inherit the worker process's environment (`project.child_env()`).
With a per-run cluster that is the driver's own environment; on an attached
cluster it is the environment of the Jupyter server when the cluster started,
shared by every project. A `module load` or `export` in the user's shell would
silently stop reaching recipes. The engine SHOULD ship the driver's
environment with each task and apply it in the recipe subprocess, excluding
variables tied to a host or a job (`SLURM_*`, `SLURMD_*`, `HOSTNAME`,
`TMPDIR`, `XDG_RUNTIME_DIR`, `JUPYTER_*`, `JPY_*`, `DISPLAY`, `SSH_*`). Whether
shipped variables enter provenance is the engine's decision.

### 9.9 Refusal texts

The refusals of section 8.4 follow the engine's existing style: one sentence
saying what was found, then the remedy, copy-pasteable where there is a
command. Remedies that point to the UI name it: "Lightcone sidebar ›
Compute".

### 9.10 Containerized projects

- **Local and Slurm clusters**: unchanged. Workers run the engine on the host
  and wrap each recipe with the container runtime; the engine's multi-node
  check (a shared image store, i.e. podman-hpc) MUST count the distinct
  worker hosts of the attached cluster instead of the allocation's nodes.
- **Gateway clusters**: not supported in this version; a containerized
  project finds no candidate there (section 8.3). Supporting them means
  Gateway clusters built per environment: worker pods running the project's
  `lc-env-<hash>` image, with the engine either layered into the image or run
  from the mounted home, and the image published to a registry the gateway
  can pull. Clusters are then shared by projects that declare the same image,
  not by all projects. This is the engine's hub work, outside this design.

### 9.11 What the engine must not do

- Start, scale, stop or write records for clusters.
- Fall back to local execution when an attached cluster cannot be used.
- Attach to a record of another format, another host's local cluster, or
  another gateway's cluster.

## 10. The Compute section

A section of the Lightcone sidebar, collapsible like Sessions, Results and
Analysis. It lists every target, one row each:

```
▾ COMPUTE                                  4 nodes
    ○ Login node                        check only
  ▌ ● Slurm cluster          4 nodes · 1 h 42 min left   ⋯
        ████████████░░░  384 of 512 threads busy
    + New cluster
```

- **Rows.** The host target is always first: _This machine_, _This server_
  (JupyterHub), _Login node_ or _This allocation_. Clusters follow, named by
  backend, with their preset label as tooltip. Clusters that cannot serve this
  project from here are listed muted, with the reason ("another image",
  "on login23").
- **Active target.** Marked with the sidebar's active bar and
  `aria-current`. Only the active target has a second line: the load of a
  running cluster, the start estimate of a queued one, or a problem with its
  single fix (**Replace**, for a cluster of another engine version, when a
  preset of the same name exists).
- **Status dot.** Green when ready (pulsing while tasks run), a gold ring while
  queued, pulsing blue while starting, gold where only checks can run (a login
  node, a containerized project without a container runtime), gold "!" for a
  problem, an empty ring otherwise.
- **Section title.** Summarizes the active target: "16 cores", "4 nodes",
  "Queued", "Check only", or "!" for a problem.
- **Row actions** (⋯ on clusters): the cluster's facts (preset, job, QOS,
  account, gateway name), **Open dashboard** when a link is available, and
  **Stop…** (**Cancel…** while queued), which asks for confirmation and warns
  that runs using the cluster, in every project, stop too.
- **New cluster** opens the presets this server can start, the last used
  first, with the node-hours a Slurm preset may charge; then **Custom…** (a
  one-off size, optionally saved as a preset) and **Edit presets…**. It
  appears where a non-local backend is available, or where a preset offers a
  local cluster.
- **Notifications.** A cluster that ends on its own (time limit, idle
  timeout, failure) is reported once, as a notification, rather than kept as a
  row: "Your Slurm cluster “Regular · 4 nodes · 2 h” reached its time limit."
- **Engine without support.** When the installed engine does not read the
  record format, the section says so and keeps the host active.

The listing refreshes every ten seconds while the sidebar is visible (backing
off on errors), and at once after every action and project change.

### 10.1 Presets

Presets are the settings of the `jupyterlab-lightcone:compute` plugin, a list
of named sizes (`schema/compute.json`):

| Field                                           | Backends | Meaning                                               |
| ----------------------------------------------- | -------- | ----------------------------------------------------- |
| `label`                                         | all      | Name shown in the menu and the row tooltip (required) |
| `backend`                                       | all      | `local`, `slurm` or `gateway` (required)              |
| `description`                                   | all      | Tooltip; the size in words when absent                |
| `threads`                                       | local    | Worker threads; every core when absent                |
| `nodes`, `time`, `qos`, `constraint`, `account` | slurm    | Job size and placement                                |
| `workers`, `cores`, `memory`                    | gateway  | Adaptive maximum; cores and GB per worker             |

Only presets for a backend the server reports as available are offered. Sites
ship presets through JupyterLab's `overrides.json`
(`{sys.prefix}/share/jupyter/lab/settings/overrides.json`); users edit their
own copy in the settings editor, which takes precedence.

NERSC Perlmutter:

```json
{
  "jupyterlab-lightcone:compute": {
    "presets": [
      {
        "label": "Debug · 1 node · 30 min",
        "backend": "slurm",
        "nodes": 1,
        "time": "30",
        "qos": "debug",
        "constraint": "cpu"
      },
      {
        "label": "Regular · 4 nodes · 2 h",
        "backend": "slurm",
        "nodes": 4,
        "time": "2:00:00",
        "qos": "regular",
        "constraint": "cpu"
      }
    ]
  }
}
```

A daskhub-style JupyterHub:

```json
{
  "jupyterlab-lightcone:compute": {
    "presets": [
      {
        "label": "Small",
        "backend": "gateway",
        "workers": 2,
        "cores": 2,
        "memory": 4
      },
      {
        "label": "Medium",
        "backend": "gateway",
        "workers": 6,
        "cores": 2,
        "memory": 4
      }
    ]
  }
}
```

A workstation needs none; a local preset is only useful for its dashboard:

```json
{
  "jupyterlab-lightcone:compute": {
    "presets": [{ "label": "Local", "backend": "local" }]
  }
}
```

## 11. HTTP API

All routes are under `{base_url}jupyterlab_lightcone/api/compute` and require
authentication. Listing requires `read` on the `lightcone` resource (and
`read` on `contents` when a project is named); starting and stopping require
`execute` on `lightcone`.

| Method and path                        | Body                                            | Result                         |
| -------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `GET /api/compute[?path=<entrypoint>]` |                                                 | `200` listing                  |
| `POST /api/compute/clusters`           | `{"preset": {…}, "path": <entrypoint> \| null}` | `201` the new cluster's target |
| `DELETE /api/compute/clusters/<id>`    |                                                 | `204`                          |

Errors: `400` for an invalid preset or an unavailable backend, `409` when a
cluster on the same backend and environment is already live, `502` when the
backend refuses (the message carries its error, such as Slurm's), `404` for an
unknown cluster.

The listing:

```json
{
  "format": "lightcone.cluster/1",
  "attaches": true,
  "lightcone": "0.5.0",
  "idleTimeout": 1800,
  "backends": ["slurm"],
  "targets": [
    {
      "id": "host",
      "kind": "host",
      "backend": null,
      "variant": "login",
      "state": "check-only",
      "active": false,
      "other": null,
      "problem": {
        "code": "login-node",
        "message": "Runs need compute nodes."
      },
      "size": { "threads": 256, "nodes": null, "workers": null }
    },
    {
      "id": "20260924-141502-k3x9",
      "kind": "cluster",
      "backend": "slurm",
      "label": "Regular · 4 nodes · 2 h",
      "state": "running",
      "active": true,
      "other": null,
      "problem": null,
      "size": { "threads": 512, "nodes": 4, "workers": 4 },
      "load": { "workers": 4, "threads": 512, "busy": 384 },
      "timeLeft": 6125,
      "startEstimate": null,
      "dashboard": "/user/someone/proxy/nid001234:40731/status",
      "details": ["Job 31415926", "regular", "cpu"],
      "created": "2026-09-24T14:15:02Z"
    }
  ],
  "ended": [
    {
      "id": "20260924-101500-ab12",
      "backend": "slurm",
      "label": "Debug · 1 node · 30 min",
      "reason": "reached its time limit",
      "at": "2026-09-24T11:00:04Z"
    }
  ]
}
```

`state` is one of `ready` and `check-only` (host), `queued`, `starting`,
`running`, `stopping` and `unknown` (clusters). `problem.code` is one of
`login-node`, `container-runtime`, `several-clusters` and `version`. `load` comes
from the scheduler's `identity` call over the cluster's TLS connection and is
null when the scheduler does not answer within three seconds. One look at the
backends serves every request for two seconds, across browser tabs. `ended`
lists clusters that ended on their own in the last fifteen minutes; clusters
stopped by the user are not listed.

## 12. Security

- **Authentication between processes.** Every local and Slurm cluster has its
  own key and self-signed certificate, which is also the CA; Dask's TLS is
  mutual, so only a process that can read the cluster's `tls/` files can join
  or drive the cluster. Encryption is required by every process. This matters
  most on shared systems: a Slurm cluster listens on the high-speed network,
  which every user of the machine can reach, and Dask executes arbitrary code
  for any client it accepts.
- **File permissions** (section 6.1) make the registry the credential store:
  whoever can read `~/.lightcone/clusters/` is the user.
- **Local clusters** listen on the loopback interface only.
- **Gateway clusters** use the gateway's per-cluster TLS and JupyterHub's
  tokens; the record holds no secret.
- **Dashboards** are plain HTTP without authentication in Dask. The extension
  links to them only through `jupyter-server-proxy`, which authenticates;
  the port itself remains reachable on the scheduler's host for the cluster's
  lifetime.
- **API authorization**: section 11. Starting a cluster executes code as the
  server user, as materializing does, and needs the same `execute`
  permission.
- **Injection**: presets reach Slurm only through `#SBATCH` lines whose values
  match strict patterns; commands are run without a shell; the interpreter
  path is quoted; `scancel` only receives job ids read from records.

## 13. Failure modes

| Failure                                                               | Behaviour                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Jupyter server crashes                                            | Local processes run on until the scheduler's idle timeout; Slurm and Gateway clusters are unaffected. The next server reconciles the registry and shows them.                                                        |
| The scheduler dies                                                    | Local: the record is removed and the ending reported. Slurm: the job ends (`wait -n`) and is reported through `sacct`. Workers exit after their 60-second death timeout.                                             |
| Slurm controller or gateway unreachable                               | Clusters show as "no answer" and stay recorded; nothing is removed.                                                                                                                                                  |
| Crash between `sbatch` and the record update                          | The job runs without a handle in its record; the record is dropped after two minutes and the job ends at its idle timeout or time limit. Known limitation; the job name (`lightcone-<id>`) allows adopting it later. |
| Two Jupyter servers for one user (named servers, several login nodes) | Both reconcile the same registry; removals are idempotent; local clusters are managed only by their own host.                                                                                                        |
| The engine or `distributed` is upgraded under a running cluster       | The cluster shows the version problem with **Replace**; the engine refuses to attach (section 8.4).                                                                                                                  |
| The idle timeout culls a cluster between runs                         | Reported once; the next run uses the host target, or refuses on a login node with the Compute section as remedy.                                                                                                     |
| A stale `scheduler.json`                                              | Only a scheduler holding the cluster's key can complete the TLS handshake, so a reused address cannot be mistaken for the cluster; the connection fails within its timeout.                                          |

## 14. Testing

The extension's suites exercise every backend without the infrastructure:

- `test_compute_records.py`: layout, permissions, atomic writes, TLS
  material, and the scheduler and worker command lines (the engine's worker
  contract).
- `test_compute_local.py`: real local clusters: start, load over TLS, attach
  from a separate process using only the record, stop, and shutdown cleanup.
- `test_compute_slurm.py`: fake `sbatch`, `squeue`, `scancel` and `sacct` on
  `PATH`: the job script (and that `bash -n` accepts it), preset validation
  against directive injection, every queue state, controller outages.
- `test_compute_gateway.py`: a fake gateway client with the real one's
  surface: options, adaptivity, reports, outages.
- `test_compute_service.py`, `test_compute_routes.py`: selection, conflicts,
  reconciliation, reporting of ended clusters, and the HTTP contract.
- `src/compute/__tests__/`: the API guards, presets, labels, the polling
  model and ended-cluster notifications, the section and its menus.

The engine will need the mirror image: attaching to a real local cluster
started from a record written by a test, the probe's refusals, run-scoped
keys under two concurrent runs, and the ladder's precedence, faked at the
host level as the engine's venue tests already are.

## 15. Rollout

1. **This change (jupyterlab-lightcone)**: the Compute section, the three
   backends, the registry writer, presets. With today's engine the section
   manages clusters and says runs stay on this host.
2. **lightcone-cli**: sections 9.1 to 9.11 in one release, announcing
   `CLUSTER_RECORD_FORMAT`. From that release on, the Compute section marks
   clusters active and runs use them.
3. **The extension calls `venue.attached_cluster()`** for the active target,
   so the selection rule has one implementation.
4. **Sites**: NERSC presets (and a Perlmutter validation, section 16); the
   Lightcone hub's `overrides.json` with Gateway presets. The hub already
   offers `image`, `worker_cores`, `worker_memory` and `environment` options
   and mounts each user's home in worker pods at the notebook's path.

## 16. Open questions and validation

- **Perlmutter**: that login nodes reach a scheduler on a compute node's
  `hsn0` address and the reverse; that `jupyter-server-proxy` there allows
  remote hosts, for dashboards; that `$HOME` suits the registry (it holds
  small files only; Dask's own scratch goes to node-local `/tmp`).
- **Interactive QOS**: a cluster held by a supervised `salloc` would start in
  minutes, at the price of ending with the Jupyter server. Worth adding if
  debug-QOS waits prove too long.
- **Growing a Slurm cluster**: an **Add nodes** action would submit a
  worker-only job joining the scheduler; left out of this version.
- **Per-project load and fair sharing**: with run-scoped keys (section 9.4)
  the section can split a cluster's load by project; Dask runs tasks roughly
  in submission order, and whether runs need priorities is open.
- **Containerized projects on Gateway** (section 9.10).
- **Orphan adoption**: find jobs named `lightcone-<id>` and Gateway clusters
  whose environment carries `LIGHTCONE_CLUSTER` but whose record lost its
  handle.

## 17. Alternatives considered

| Alternative                                                               | Why not                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **dask-labextension** as the backend                                      | Clusters live only in the Jupyter server's memory: no other process can find them, a restart forgets them, clusters started elsewhere never appear. One cluster type per server, no per-cluster options, no credentials in its model (its inserted client code fails under TLS). Its dashboard panes remain worth reusing for **Open dashboard**. |
| **dask-ctl** discovery                                                    | Dormant since early 2024 and no longer importable with current `distributed`. Its idea, asking each backend rather than trusting a file, is kept in section 6.5.                                                                                                                                                                                  |
| **dask-jobqueue** `SLURMCluster` in the Jupyter server                    | The scheduler would live in the server process: it dies with the server, competes with it for a login node's per-user limits, and worker jobs trickle in one by one. Its job-runner mode, a scheduler inside the job, is the shape used here.                                                                                                     |
| **dask-gateway with a Slurm backend**                                     | Needs a site-installed service with sudo rights to launch as each user; not something a user can deploy.                                                                                                                                                                                                                                          |
| **ipyparallel** clusters                                                  | Another runtime (ZeroMQ, IPython engines) where the engine is built on Dask. Its registry of cluster files in the IPython profile, reloaded on every listing, inspired this one.                                                                                                                                                                  |
| **Clusters per run, created by the engine** (today's model)               | No queue or pod start-up amortization, which is the point of this work.                                                                                                                                                                                                                                                                           |
| **Holding a bare allocation and running `lc` inside it** (`srun --jobid`) | Keeps the engine unchanged on Slurm, but has no Kubernetes or workstation equivalent, and terminals and agents would have to enter the allocation themselves.                                                                                                                                                                                     |
| **Environment variables as the rendezvous** (`DASK_SCHEDULER_ADDRESS`)    | Reach only processes started afterwards, carry no credentials, and cannot say that a cluster ended.                                                                                                                                                                                                                                               |

## 18. References

- Dask deployment: <https://docs.dask.org/en/stable/deploying.html>
- Dask TLS: <https://distributed.dask.org/en/stable/tls.html>
- Dask Gateway: <https://gateway.dask.org/>
- dask-jobqueue: <https://jobqueue.dask.org/>
- NERSC Jupyter: <https://docs.nersc.gov/services/jupyter/>
- NERSC queues and QOS: <https://docs.nersc.gov/jobs/policy/>
- NERSC Dask examples: <https://gitlab.com/NERSC/nersc-notebooks/-/tree/main/perlmutter/dask>
- JupyterLab settings overrides: <https://jupyterlab.readthedocs.io/en/stable/user/directories.html#overridesjson>
