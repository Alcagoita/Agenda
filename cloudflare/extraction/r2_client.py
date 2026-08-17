"""
KAN-354. R2 upload via the Worker's own binding, same "outbound Worker"
mechanism as d1_client.py — a PUT to `http://r2.internal/<key>` is
intercepted and translated into `env.POI_EXPORTS.put(key, body)`. No R2
access-key/secret-key pair needed.
"""
import urllib.parse
import requests

R2_BASE_URL = 'http://r2.internal/'

class R2Error(Exception):
    pass

def upload_file(local_path, r2_key):
    url = R2_BASE_URL + urllib.parse.quote(r2_key, safe='')
    with open(local_path, 'rb') as f:
        res = requests.put(url, data=f, timeout=120)
    if not res.ok:
        raise R2Error(f'R2 outbound upload failed ({res.status_code}) for {r2_key}: {res.text[:500]}')
    return r2_key

def upload_bytes(data, r2_key, content_type='application/json'):
    """Put an in-memory artifact without staging it on container-local disk.

    KAN-387's per-scope rename reports are small and are written one per
    municipality; a file that only lives inside the container is lost with
    the instance, which is the whole failure this replaced.
    """
    url = R2_BASE_URL + urllib.parse.quote(r2_key, safe='')
    payload = data.encode('utf-8') if isinstance(data, str) else data
    res = requests.put(url, data=payload, headers={'Content-Type': content_type}, timeout=60)
    if not res.ok:
        raise R2Error(f'R2 outbound upload failed ({res.status_code}) for {r2_key}: {res.text[:500]}')
    return r2_key

def download_file(r2_key, local_path):
    """Restore a durable raw extract for a reconciliation-only retry."""
    url = R2_BASE_URL + urllib.parse.quote(r2_key, safe='')
    res = requests.get(url, timeout=120)
    if not res.ok:
        raise R2Error(f'R2 outbound download failed ({res.status_code}) for {r2_key}: {res.text[:500]}')
    with open(local_path, 'wb') as f:
        f.write(res.content)
    return local_path
