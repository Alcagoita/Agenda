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
