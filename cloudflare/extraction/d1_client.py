"""
KAN-354. D1 access via Cloudflare's HTTP Query API — not the `wrangler d1
execute` CLI the manual pipeline printed instructions for, since the Cloud
Run Job container has no reason to carry a Node/wrangler toolchain just to
run SQL it already has as text. One HTTP call per statement/batch file;
Cloudflare's API takes a single `sql` string plus positional `params`, or
(for this pipeline's pre-built statement text) a raw multi-statement string
is NOT supported — each statement must be sent individually, so
`execute_sql_file` splits on the same `;\n` boundary classify_and_load.py
itself writes with.
"""
import os
import time
import requests

D1_API_BASE = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query'

class D1Error(Exception):
    pass

def _account_id():
    v = os.environ['CLOUDFLARE_ACCOUNT_ID']
    return v

def _database_id():
    return os.environ['CLOUDFLARE_D1_DATABASE_ID']

def _api_token():
    return os.environ['CLOUDFLARE_API_TOKEN']

def execute(sql, params=None, retries=3):
    """One statement (or one D1-batch-safe multi-statement string — D1's
    HTTP API does allow multiple `;`-separated statements in a single call,
    unlike some other SQL HTTP APIs; used for the sweep DELETEs). Retries on
    transport failure and 5xx only — a 4xx (bad SQL, bad auth) retrying
    would just repeat the same failure."""
    url = D1_API_BASE.format(account_id=_account_id(), database_id=_database_id())
    headers = {'Authorization': f'Bearer {_api_token()}', 'Content-Type': 'application/json'}
    body = {'sql': sql}
    if params is not None:
        body['params'] = params

    last_error = None
    for attempt in range(retries):
        try:
            res = requests.post(url, headers=headers, json=body, timeout=30)
        except requests.RequestException as e:
            last_error = e
            time.sleep(2 ** attempt)
            continue
        if res.status_code >= 500:
            last_error = D1Error(f'D1 API {res.status_code}: {res.text[:500]}')
            time.sleep(2 ** attempt)
            continue
        if res.status_code >= 400:
            raise D1Error(f'D1 API {res.status_code}: {res.text[:1000]}')
        data = res.json()
        if not data.get('success'):
            raise D1Error(f'D1 API reported failure: {data.get("errors")}')
        return data['result']
    raise D1Error(f'D1 API unreachable after {retries} attempts: {last_error}')

def execute_sql_file(path):
    """Splits classify_and_load.py's own output on the `;\\n` statement
    boundary it writes and executes each one — mirrors what `wrangler d1
    execute --file` did for the manual workflow, minus the CLI dependency.
    Every statement in one D1 batch endpoint call would be preferable
    (atomic), but Cloudflare's HTTP Query API only started supporting an
    explicit batch array after this was written — sequential execute() calls
    for now; not atomic across statements, same non-atomicity the manual
    pipeline's own multi-command upload sequence already had (see schema.sql's
    top comment on the sweep-delete tradeoff)."""
    with open(path) as f:
        content = f.read()
    statements = [s.strip() for s in content.split(';\n') if s.strip()]
    for stmt in statements:
        execute(stmt + ';')
