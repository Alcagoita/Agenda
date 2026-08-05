/**
 * KAN-354. Tiny Cloud Run *service* (not the Job) sitting in front of the
 * extraction Job — its only reason to exist is auth. The Worker
 * (BUILD_TRIGGER_URL) POSTs { mode, target } here with X-Build-Secret; this
 * service checks that secret, then starts a Cloud Run Jobs execution using
 * its own attached service account's ambient credentials (Application
 * Default Credentials — no key file to manage or leak).
 *
 * Why not have the Worker call the Jobs API directly? Cloudflare Workers
 * have no ambient GCP identity — the Worker would need a service-account
 * JSON key stored as a Cloudflare secret, which is real key material to
 * rotate/leak-manage for comparatively little benefit over this one extra
 * cheap (scales to zero) hop.
 *
 * No framework — one route, plain `http`, minimal surface to audit.
 */
const http = require('http');
const { GoogleAuth } = require('google-auth-library');

const PORT = process.env.PORT || 8080;
const BUILD_TRIGGER_SECRET = process.env.BUILD_TRIGGER_SECRET;
const GCP_PROJECT = process.env.GCP_PROJECT;
const GCP_REGION = process.env.GCP_REGION || 'europe-west1';
const JOB_NAME = process.env.EXTRACTION_JOB_NAME || 'brush-poi-extraction';

if (!BUILD_TRIGGER_SECRET) {
  throw new Error('BUILD_TRIGGER_SECRET is required');
}

const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

async function runJob(mode, target) {
  const client = await auth.getClient();
  const jobPath = `projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
  const url = `https://run.googleapis.com/v2/${jobPath}:run`;
  const res = await client.request({
    url,
    method: 'POST',
    data: {
      overrides: {
        containerOverrides: [{
          env: [
            { name: 'MODE', value: mode },
            { name: 'TARGET', value: target },
          ],
        }],
      },
    },
  });
  return res.data;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-build-secret'] !== BUILD_TRIGGER_SECRET) {
    res.writeHead(401).end();
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    const { mode, target } = parsed;
    if (mode !== 'place' && mode !== 'country') {
      res.writeHead(400).end(JSON.stringify({ error: "mode must be 'place' or 'country'" }));
      return;
    }
    if (typeof target !== 'string' || target.trim() === '') {
      res.writeHead(400).end(JSON.stringify({ error: 'target must be a non-empty string' }));
      return;
    }

    try {
      // Fire-and-forget from the Worker's perspective too — respond as
      // soon as the Jobs API accepts the execution request, don't wait for
      // the (minutes-long, per docs/poi-coverage-model.md) job to finish.
      const execution = await runJob(mode, target);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, execution: execution.name }));
    } catch (err) {
      console.error('[trigger-service] failed to start Job execution', err);
      res.writeHead(502).end(JSON.stringify({ error: 'failed to start Job execution' }));
    }
  });
});

server.listen(PORT, () => console.log(`[trigger-service] listening on ${PORT}`));
