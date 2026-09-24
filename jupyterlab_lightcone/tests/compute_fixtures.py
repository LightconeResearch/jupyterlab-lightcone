"""A backend whose clusters exist only in memory, for the service and route suites."""

from jupyterlab_lightcone.compute.backend import BackendError, Status, integer
from jupyterlab_lightcone.compute.records import write_record


class FakeBackend:
    """Starts nothing; reports whatever status a test sets for each cluster."""

    def __init__(self, name="slurm", available=True):
        self.name = name
        self.is_available = available
        self.states: dict[str, Status] = {}
        self.default = Status("queued")
        self.started = []
        self.stopped = []
        self.fail_start = None
        self.fail_stop = None

    def available(self) -> bool:
        return self.is_available

    def validate(self, preset: dict) -> dict:
        return {"nodes": integer(preset, "nodes", 1, 1, 100)}

    async def start(self, record, spec):
        self.started.append((record.id, spec, record.path("cluster.json").is_file()))
        if self.fail_start:
            raise BackendError(self.fail_start)
        record.data[self.name] = {"job": str(len(self.started)), **spec}
        write_record(record)

    async def statuses(self, records):
        return {record.id: self.states.get(record.id, self.default) for record in records}

    async def stop(self, record):
        if self.fail_stop:
            raise BackendError(self.fail_stop)
        self.stopped.append(record.id)
