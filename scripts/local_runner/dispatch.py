"""One FIFO dispatcher for source verification and catalogued builds."""
from pathlib import Path

from local_runner.queue import JobQueue
from local_runner.coordinator import execute_once, configured_image, reconcile
from local_runner.build_executor import execute_build, reconcile_build


def execute_next(layout, owner):
    queue = JobQueue(Path(layout['storage_root']) / 'index' / 'runner-jobs.sqlite')
    job = queue.next_queued(owner)
    if job is None:
        return None
    if job['operation'] == 'build':
        return execute_build(layout, owner=owner, expected_job_id=job['job_id'])
    return execute_once(layout, owner=owner, image_digest=configured_image(layout, owner), expected_job_id=job['job_id'])


def recover(layout, job_id, owner):
    queue = JobQueue(Path(layout['storage_root']) / 'index' / 'runner-jobs.sqlite')
    if queue.get(job_id)['operation'] == 'build':
        return reconcile_build(layout, job_id, owner=owner)
    return reconcile(layout, job_id, owner=owner)
