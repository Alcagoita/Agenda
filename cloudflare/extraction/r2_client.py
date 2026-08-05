"""
KAN-354. R2 upload via its S3-compatible API (boto3) — replaces the manual
pipeline's printed `wrangler r2 object put` instructions the same way
d1_client.py replaces `wrangler d1 execute`: the Job container has no reason
to carry Node/wrangler for this.
"""
import os
import boto3

def _client():
    account_id = os.environ['CLOUDFLARE_ACCOUNT_ID']
    return boto3.client(
        's3',
        endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
    )

def upload_file(local_path, r2_key, bucket=None):
    bucket = bucket or os.environ.get('R2_BUCKET', 'brush-poi-exports')
    _client().upload_file(local_path, bucket, r2_key)
    return r2_key
