"""
KAN-354. D1 access via the Worker's own binding, reached through an
"outbound Worker" hostname (extractionContainer.ts's `outboundByHost`) —
not a separate Cloudflare API token. A plain HTTP request to
`http://d1.internal/` from inside the container is intercepted by the
Workers runtime and translated into `env.REGISTRY_DB.prepare(sql).run()`;
no real DNS entry for that hostname needs to exist.

Writes use D1's ``.run()``.  KAN-383's OSM supplementary importer also needs
read-only identity scans, so ``select()`` explicitly requests ``.all()``.
"""
import requests

D1_URL = 'http://d1.internal/'

class D1Error(Exception):
    pass

def execute(sql):
    """One SQL statement. Raises D1Error on any failure — the Worker-side
    handler reports D1 errors as a 500 with the error message, which
    surfaces here as a non-2xx response."""
    res = requests.post(D1_URL, json={'sql': sql}, timeout=30)
    if not res.ok:
        raise D1Error(f'D1 outbound call failed ({res.status_code}): {res.text[:1000]}')
    data = res.json()
    if not data.get('success'):
        raise D1Error(f'D1 reported failure: {data.get("error")}')
    return data.get('meta')

def select(sql):
    """Run a read-only SELECT through the Worker binding and return rows."""
    res = requests.post(D1_URL, json={'sql': sql, 'mode': 'all'}, timeout=30)
    if not res.ok:
        raise D1Error(f'D1 outbound read failed ({res.status_code}): {res.text[:1000]}')
    data = res.json()
    if not data.get('success'):
        raise D1Error(f'D1 reported read failure: {data.get("error")}')
    return data.get('results') or []

def execute_sql_file(path):
    """Splits classify_and_load.py's own output on the `;\\n` statement
    boundary it writes and executes each one."""
    with open(path) as f:
        content = f.read()
    statements = [s.strip() for s in content.split(';\n') if s.strip()]
    for stmt in statements:
        execute(stmt + ';')
