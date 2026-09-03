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

def execute_many(statements):
    """Execute at most 50 generated writes in one D1 batch request.

    The country importer still creates bounded SQL statements, but batching
    their transport avoids turning a 440k-row import into thousands of HTTP
    round trips against the Worker/D1 binding.
    """
    statements = list(statements)
    if not statements or len(statements) > 50:
        raise ValueError('execute_many requires 1 to 50 statements')
    res = requests.post(D1_URL, json={'sqls': statements}, timeout=60)
    if not res.ok:
        raise D1Error(f'D1 outbound batch failed ({res.status_code}): {res.text[:1000]}')
    data = res.json()
    if not data.get('success'):
        raise D1Error(f'D1 reported batch failure: {data.get("error")}')
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

def execute_sql_file(path, statements_per_request=50):
    """Splits classify_and_load.py's own output on the `;\\n` statement
    boundary it writes and executes each one."""
    if not 1 <= statements_per_request <= 50:
        raise ValueError('statements_per_request must be between 1 and 50')
    with open(path) as f:
        content = f.read()
    statements = [s.strip() for s in content.split(';\n') if s.strip()]
    for start in range(0, len(statements), statements_per_request):
        execute_many(stmt + ';' for stmt in statements[start:start + statements_per_request])
