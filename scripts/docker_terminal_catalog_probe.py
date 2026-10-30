"""Read-only proof used only by explicit native-terminal graceful drain."""

# Executed in the pinned backend by the managed launcher. It grants admission
# to authenticated native drain, never authority to release a lease or replay work.
PROBE = r'''
def native_terminal_catalog_proof(run_id):
    import pathlib
    if not isinstance(run_id,str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",run_id) is None:
        raise RuntimeError("native terminal proof needs an exact run")
    def read(path):
        path=pathlib.Path(path)
        if not path.is_absolute() or path.resolve()!=path:
            raise RuntimeError("native terminal proof path is not canonical")
        fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,"rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise RuntimeError("native terminal proof is not a regular file")
            raw=source.read(MAX+1)
        if len(raw)>MAX: raise RuntimeError("native terminal proof exceeds bound")
        value=json.loads(raw,object_pairs_hook=unique_object)
        if not isinstance(value,dict): raise RuntimeError("native terminal proof is not an object")
        return value,hashlib.sha256(raw).hexdigest()
    config,config_sha=read(os.environ['FULLMAG_RUNTIME_SERVICE_CONFIG'])
    root=pathlib.Path(config['store_root'])
    catalog,catalog_sha=read(root/'runs'/run_id/'run_catalog.json')
    tasks=catalog.get('tasks')
    if (catalog.get('schema_version')!='run_catalog.v1' or catalog.get('run_id')!=run_id
            or not isinstance(tasks,list) or not tasks
            or any(not isinstance(t,dict) or t.get('lifecycle') not in
                   {'succeeded','failed','cancelled','interrupted'} for t in tasks)):
        raise RuntimeError("native terminal proof refuses unfinished tasks")
    ledger,_=read(pathlib.Path(config['host_execution']['ledger_root'])/'HOST_RESOURCE_LEDGER.json')
    reservations=ledger.get('reservations')
    if not isinstance(reservations,list): raise RuntimeError("missing reservation inventory")
    for r in reservations:
        if (not isinstance(r,dict) or r.get('state')!='released'
                or not isinstance(r.get('release_proof_sha256'),str)
                or re.fullmatch(r'[0-9a-f]{64}',r['release_proof_sha256']) is None):
            raise RuntimeError("native terminal proof refuses unreleased reservations")
    return {'run_id':run_id,'config_sha256':config_sha,'catalog_sha256':catalog_sha,
            'released_reservations_sha256':hashlib.sha256(json.dumps(reservations,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
'''
