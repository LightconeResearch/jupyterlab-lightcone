"""Slurm clusters, against fake sbatch, squeue, scancel and sacct: the suite never needs Slurm."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import textwrap

import pytest

from jupyterlab_lightcone.compute import records
from jupyterlab_lightcone.compute.backend import BackendError, PresetError
from jupyterlab_lightcone.compute.records import FORMAT, Record
from jupyterlab_lightcone.compute.slurm import SlurmBackend, job_script, seconds

TLS = {"ca": "tls/cert.pem", "cert": "tls/cert.pem", "key": "tls/key.pem"}
SPEC = {"nodes": 4, "time": "2:00:00", "qos": "regular", "constraint": "cpu", "account": None}

FAKE_TOOL = textwrap.dedent(
    """\
    import json, os, sys
    from pathlib import Path
    state_path = Path(os.environ["FAKE_SLURM_STATE"])
    state = json.loads(state_path.read_text())
    tool = Path(sys.argv[0]).name
    state.setdefault("calls", []).append({"tool": tool, "argv": sys.argv[1:], "cwd": os.getcwd()})
    code = 0
    if tool == "sbatch":
        if state.get("refuse"):
            sys.stderr.write(state["refuse"])
            code = 1
        else:
            print(state.get("job", "4242"))
    elif tool == "squeue":
        if state.get("down"):
            sys.stderr.write("slurm_load_jobs error: Unable to contact slurm controller")
            code = 1
        else:
            print("\\n".join(state.get("queue", [])))
    elif tool == "scancel":
        code = state.get("scancel_code", 0)
    elif tool == "sacct":
        print(state.get("accounting", ""))
    state_path.write_text(json.dumps(state))
    sys.exit(code)
    """
)


@pytest.fixture
def slurm(tmp_path, monkeypatch):
    """Fake Slurm commands on PATH, sharing one JSON state file."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("sbatch", "squeue", "scancel", "sacct"):
        script = bin_dir / tool
        script.write_text(f"#!{sys.executable}\n{FAKE_TOOL}")
        script.chmod(0o755)
    state = tmp_path / "slurm.json"
    state.write_text("{}")
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_SLURM_STATE", str(state))

    class Fake:
        def set(self, **values):
            data = json.loads(state.read_text())
            data.update(values)
            state.write_text(json.dumps(data))

        @property
        def calls(self):
            return json.loads(state.read_text()).get("calls", [])

    return Fake()


def make_record(tmp_path, **extra) -> Record:
    cluster_id = records.new_cluster_id()
    directory = records.make_directory(tmp_path / "clusters", cluster_id)
    return Record(directory, {"format": FORMAT, "id": cluster_id, "backend": "slurm", "label": "Regular", "tls": TLS, **extra})


def backend() -> SlurmBackend:
    return SlurmBackend(1800, shutil.which)


def test_the_job_is_a_scheduler_and_one_worker_per_node(tmp_path):
    record = make_record(tmp_path)
    script = job_script(record, SPEC, "/opt/lc/bin/python", 1800)
    directives = [line for line in script.splitlines() if line.startswith("#SBATCH")]
    assert directives == [
        f"#SBATCH --job-name=lightcone-{record.id}",
        "#SBATCH --nodes=4",
        "#SBATCH --time=2:00:00",
        "#SBATCH --output=slurm-%j.out",
        "#SBATCH --qos=regular",
        "#SBATCH --constraint=cpu",
    ]
    assert "export DASK_DISTRIBUTED__COMM__REQUIRE_ENCRYPTION=True" in script
    assert "unset SLURM_CPUS_PER_TASK SLURM_TRES_PER_TASK" in script
    scheduler = next(line for line in script.splitlines() if "dask_scheduler" in line)
    assert '--host "$host"' in scheduler and '--dashboard-address "$host:0"' in scheduler
    assert "--idle-timeout 1800s" in scheduler
    worker = next(line for line in script.splitlines() if line.startswith("srun "))
    for fragment in ("--overlap", '--ntasks="$SLURM_JOB_NUM_NODES"', "--ntasks-per-node=1", '--cpus-per-task="$cpus"', '--nthreads "$cpus"', "--no-nanny", "--memory-limit 0"):
        assert fragment in worker
    assert worker.startswith("srun ") and "/opt/lc/bin/python -m distributed.cli.dask_worker" in worker


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash to parse the script")
def test_the_job_script_is_valid_bash(tmp_path):
    script = tmp_path / "job.sh"
    script.write_text(job_script(make_record(tmp_path), SPEC, "/opt/lc bin/python", 1800))
    assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0


def test_a_preset_needs_little(tmp_path):
    assert backend().validate({}) == {"nodes": 1, "time": "1:00:00", "qos": None, "constraint": None, "account": None}
    assert backend().validate({"constraint": "gpu&hbm80g", "account": "m1234_g", "time": "1-00:00:00"})["constraint"] == "gpu&hbm80g"


@pytest.mark.parametrize(
    "preset",
    [
        {"qos": "regular\n#SBATCH --x=1"},
        {"account": "m1234 --wrap"},
        {"constraint": "cpu;rm"},
        {"time": "2 hours"},
        {"time": 120},
        {"nodes": 0},
        {"nodes": True},
        {"nodes": "4"},
    ],
)
def test_presets_cannot_escape_their_directives(preset):
    with pytest.raises(PresetError):
        backend().validate(preset)


@pytest.mark.parametrize(
    "text, expected",
    [("42:05", 2525), ("1:42:05", 6125), ("2-00:00:00", 172800), ("2-03", 183600), ("2-03:30", 185400), ("30", 1800), ("UNLIMITED", None), ("INVALID", None)],
)
def test_slurm_durations(text, expected):
    assert seconds(text) == expected


def test_it_needs_the_slurm_commands(slurm):
    assert backend().available()
    assert not SlurmBackend(1800, lambda tool: None).available()


async def test_submitting_records_the_job(tmp_path, slurm):
    record = make_record(tmp_path)
    await backend().start(record, SPEC)
    assert record.data["slurm"] == {"job": "4242", "nodes": 4, "time": "2:00:00", "qos": "regular", "constraint": "cpu"}
    call = slurm.calls[0]
    assert call["tool"] == "sbatch" and call["argv"] == ["--parsable", "job.sh"]
    assert Path(call["cwd"]).resolve() == record.directory.resolve()
    assert record.path("job.sh").read_text().startswith("#!/bin/bash")


async def test_a_refused_submission_says_why(tmp_path, slurm):
    slurm.set(refuse="sbatch: error: Invalid qos specification")
    with pytest.raises(BackendError, match="Invalid qos specification"):
        await backend().start(make_record(tmp_path), SPEC)


async def test_the_queue_decides_each_state(tmp_path, slurm):
    queued, starting, running, ending, gone = (make_record(tmp_path, slurm={"job": job}) for job in ("1", "2", "3", "4", "5"))
    running.path(records.SCHEDULER_FILE).write_text('{"address": "tls://nid001:4000"}')
    slurm.set(
        queue=[
            "1|PENDING|2026-09-24T14:05:00|2:00:00",
            "2|RUNNING|2026-09-24T13:00:00|1:59:30",
            "3|RUNNING|2026-09-24T13:00:00|1:42:05",
            "4|COMPLETING|2026-09-24T13:00:00|0:00",
        ],
        accounting="TIMEOUT",
    )
    statuses = await backend().statuses([queued, starting, running, ending, gone])
    assert statuses[queued.id].state == "queued"
    assert statuses[queued.id].start_estimate == "2026-09-24T14:05:00"
    assert statuses[starting.id].state == "starting"
    assert statuses[running.id].state == "running"
    assert statuses[running.id].time_left == 6125
    assert statuses[ending.id].state == "stopping"
    assert statuses[gone.id].state == "gone"
    assert statuses[gone.id].reason == "reached its time limit"


async def test_a_pending_job_without_an_estimate_has_none(tmp_path, slurm):
    record = make_record(tmp_path, slurm={"job": "7"})
    slurm.set(queue=["7|PENDING|N/A|2:00:00"])
    assert (await backend().statuses([record]))[record.id].start_estimate is None


async def test_an_unreachable_controller_forgets_nothing(tmp_path, slurm):
    record = make_record(tmp_path, slurm={"job": "1"})
    slurm.set(down=True)
    assert (await backend().statuses([record]))[record.id].state == "unknown"


async def test_stop_cancels_the_job(tmp_path, slurm):
    record = make_record(tmp_path, slurm={"job": "4242"})
    await backend().stop(record)
    assert slurm.calls[-1]["tool"] == "scancel" and slurm.calls[-1]["argv"] == ["4242"]
    slurm.set(scancel_code=1)
    with pytest.raises(BackendError):
        await backend().stop(record)
