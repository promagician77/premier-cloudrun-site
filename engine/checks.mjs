// Preflight checks on a plan before anything is created. Each check reads the generated
// commands themselves, not the settings, so what is checked is what would run.
import { buildPlan, gcloudSteps } from './plan.mjs';

const flag = (step, name) => step.flags.find(([k]) => k === name);
const val = (step, name) => (flag(step, name) || [])[1];
const find = (steps, path) => steps.filter((s) => s.path.join(' ') === path);

export const CHECKS = [
  {
    id: 'domain-ga', label: 'Custom domain uses a GA feature',
    why: 'Cloud Run domain mappings are Preview and Google says not to use pre-GA offerings with PHI; the load balancer path is GA.',
    run: (steps) => (find(steps, 'beta run domain-mappings create').length ? { status: 'fail', detail: 'gcloud beta run domain-mappings create (Preview)' } : { status: 'pass', detail: 'global external Application Load Balancer with a Google-managed certificate' }),
  },
  {
    id: 'sql-private', label: 'Cloud SQL has no public IP',
    why: 'With --no-assign-ip the database is reachable only inside the VPC.',
    run: (steps) => { const s = find(steps, 'sql instances create')[0]; return flag(s, '--no-assign-ip') ? { status: 'pass', detail: '--no-assign-ip' } : { status: 'fail', detail: 'public IP assigned' }; },
  },
  {
    id: 'sql-tls', label: 'Database connections must use TLS',
    why: 'ENCRYPTED_ONLY refuses unencrypted connections, even inside the VPC.',
    run: (steps) => { const s = find(steps, 'sql instances create')[0]; const v = val(s, '--ssl-mode'); return v === 'ENCRYPTED_ONLY' || v === 'TRUSTED_CLIENT_CERTIFICATE_REQUIRED' ? { status: 'pass', detail: `--ssl-mode=${v}` } : { status: 'fail', detail: `--ssl-mode=${v}` }; },
  },
  {
    id: 'sql-pitr', label: 'Point-in-time recovery on',
    why: 'Daily backups alone lose up to a day; PITR restores to a moment within the log retention window.',
    run: (steps) => { const s = find(steps, 'sql instances create')[0]; return flag(s, '--enable-point-in-time-recovery') ? { status: 'pass', detail: `${val(s, '--retained-transaction-log-days')} days of logs, ${val(s, '--retained-backups-count')} backups` } : { status: 'fail', detail: 'backups only' }; },
  },
  {
    id: 'sql-protect', label: 'Deletion protection on',
    why: 'A mistyped delete command cannot remove the instance.',
    run: (steps) => { const s = find(steps, 'sql instances create')[0]; return flag(s, '--deletion-protection') ? { status: 'pass', detail: '--deletion-protection' } : { status: 'warn', detail: 'not set' }; },
  },
  {
    id: 'secret-pinned', label: 'Secret pinned to a version',
    why: 'Environment-variable secrets are read when an instance starts, so "latest" lets instances of one revision hold different passwords after a rotation.',
    run: (steps) => { const bad = steps.filter((s) => (val(s, '--set-secrets') || '').endsWith(':latest')); return bad.length ? { status: 'fail', detail: `${bad.length} command(s) use :latest` } : { status: 'pass', detail: 'every --set-secrets names a version' }; },
  },
  {
    id: 'runtime-sa', label: 'App runs as its own service account',
    why: 'The default compute service account often holds the project-wide Editor role.',
    run: (steps) => { const bad = steps.filter((s) => (val(s, '--service-account') || '').includes('-compute@developer')); return bad.length ? { status: 'fail', detail: 'default compute service account' } : { status: 'pass', detail: 'dedicated account, two secrets and one bucket' }; },
  },
  {
    id: 'no-project-roles', label: 'Runtime account has no project-wide roles',
    why: 'Access is granted on the secret and the bucket, so a compromised instance cannot reach anything else.',
    run: (steps, plan) => { const sa = plan.names.saEmail; const bad = find(steps, 'projects add-iam-policy-binding').filter((s) => (val(s, '--member') || '').includes(sa)); return bad.length ? { status: 'fail', detail: `${bad.length} project-level binding(s)` } : { status: 'pass', detail: 'resource-level bindings only' }; },
  },
  {
    id: 'ingress', label: 'run.app address closed once the domain is live',
    why: 'With the load balancer in front, ingress "internal and Cloud Load Balancing" blocks direct requests to the run.app URL.',
    run: (steps) => {
      const mapping = find(steps, 'beta run domain-mappings create').length > 0;
      if (mapping) return { status: 'warn', detail: 'domain mapping needs ingress all' };
      const u = find(steps, 'run services update').find((s) => flag(s, '--ingress'));
      return u && val(u, '--ingress') === 'internal-and-cloud-load-balancing' ? { status: 'pass', detail: '--ingress=internal-and-cloud-load-balancing' } : { status: 'fail', detail: `--ingress=${u ? val(u, '--ingress') : 'all'}` };
    },
  },
  {
    id: 'private-first', label: 'Nothing public before smoke tests',
    why: 'The first deploy requires an identity token; the public binding comes after the load balancer and TLS.',
    run: (steps) => { const d = find(steps, 'run deploy')[0]; return flag(d, '--no-allow-unauthenticated') ? { status: 'pass', detail: 'first deploy is IAM-only' } : { status: 'warn', detail: 'public from the first deploy' }; },
  },
  {
    id: 'readiness', label: 'Startup probe checks the database',
    why: 'Cloud Run waits for the startup probe before a deployment succeeds, so a revision that cannot log in never takes traffic.',
    run: (steps) => { const d = find(steps, 'run deploy')[0]; return (val(d, '--startup-probe') || '').includes('/readyz') ? { status: 'pass', detail: 'httpGet /readyz' } : { status: 'warn', detail: 'default TCP probe only' }; },
  },
  {
    id: 'bucket', label: 'Bucket locked down',
    why: 'Uniform bucket-level access and public access prevention stop object ACLs and public links.',
    run: (steps) => { const b = find(steps, 'storage buckets create')[0]; return flag(b, '--public-access-prevention') && flag(b, '--uniform-bucket-level-access') ? { status: 'pass', detail: 'uniform access, public access prevented' } : { status: 'fail', detail: 'object ACLs or public access possible' }; },
  },
  {
    id: 'rotation', label: 'Password can rotate without dropping requests',
    why: 'PostgreSQL holds one password per login; two logins let the new revision start on fresh credentials before the old ones are retired.',
    run: (steps) => (find(steps, 'sql users create').length >= 2 ? { status: 'pass', detail: 'app_a and app_b' } : { status: 'warn', detail: 'one login: rotation needs a redeploy window with errors' }),
  },
  {
    id: 'contractor', label: 'My access expires by itself',
    why: 'Every grant to my account carries an IAM condition with an end date.',
    run: (steps) => { const g = find(steps, 'projects add-iam-policy-binding').filter((s) => (val(s, '--member') || '').startsWith('user:')); const open = g.filter((s) => !flag(s, '--condition')); return open.length ? { status: 'fail', detail: `${open.length} standing grant(s)` } : { status: 'pass', detail: `${g.length} roles, each with an expiry` }; },
  },
  {
    id: 'one-region', label: 'Everything in one region',
    why: 'Cloud Run, Cloud SQL, the connector, the bucket and the secrets sit together; the serverless NEG must be in the service\'s region.',
    run: (steps, plan) => {
      const r = plan.config.region;
      const regions = new Set();
      for (const s of steps) for (const k of ['--region', '--location', '--network-endpoint-group-region']) { const v = val(s, k); if (v) regions.add(v); }
      return regions.size === 1 && regions.has(r) ? { status: 'pass', detail: r } : { status: 'fail', detail: [...regions].join(', ') };
    },
  },
];

export function preflight(config = {}) {
  const plan = buildPlan(config);
  const steps = gcloudSteps(plan);
  const results = CHECKS.map((c) => ({ id: c.id, label: c.label, why: c.why, ...c.run(steps, plan) }));
  return { plan, results, fails: results.filter((r) => r.status === 'fail').length, warns: results.filter((r) => r.status === 'warn').length };
}
