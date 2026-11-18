// The runbook the client keeps: where everything lives, redeploy, roll back, rotate the
// database password, restore. Generated from the same names as the plan.
import { buildPlan, render } from './plan.mjs';

const g = (path, args = [], flags = [], note = '') => ({ type: 'gcloud', path, args, flags, note });
const shl = (text, note = '') => ({ type: 'shell', text, note });

export function runbook(input = {}) {
  const plan = buildPlan(input);
  const c = plan.config;
  const n = plan.names;
  const R = ['--region', c.region];
  const console = (path) => `https://console.cloud.google.com/${path}?project=${c.project}`;
  const where = [
    ['Cloud Run service', c.service, c.region, console(`run/detail/${c.region}/${c.service}`)],
    ['Migration job', n.migrateJob, c.region, console(`run/jobs/details/${c.region}/${n.migrateJob}`)],
    ['Cloud SQL instance', `${c.sqlInstance} (private IP only)`, c.region, console(`sql/instances/${c.sqlInstance}/overview`)],
    ['Database and logins', `${c.database}; app_a, app_b (role vc_app); postgres for admin`, c.region, console(`sql/instances/${c.sqlInstance}/users`)],
    ['Secrets', `${n.secretA}, ${n.secretB}, ${n.secretAdmin}`, c.region, console('security/secret-manager')],
    ['Bucket', `gs://${n.bucket}`, c.region, console(`storage/browser/${n.bucket}`)],
    ['Runtime service account', n.saEmail, 'global', console('iam-admin/serviceaccounts')],
    [c.vpcMode === 'connector' ? 'VPC connector' : 'Direct VPC egress subnet', c.vpcMode === 'connector' ? `${c.connector} (${c.connectorRange})` : n.subnet, c.region, console('networking/connectors/list')],
    ['Images', `${c.region}-docker.pkg.dev/${c.project}/${c.repo}`, c.region, console(`artifacts/docker/${c.project}/${c.region}/${c.repo}`)],
    ...(c.domainMethod === 'lb' ? [['Load balancer and certificate', `${n.lb.urlmap}, ${n.lb.cert}, IP ${n.lb.ip}`, 'global', console('net-services/loadbalancing/list/loadBalancers')]] : [['Domain mapping', c.domain, c.region, console('run/domains')]]),
    ['Logs', `resource.type="cloud_run_revision" AND resource.labels.service_name="${c.service}"`, '', console('logs/query')],
  ];
  const sections = [
    {
      id: 'redeploy', title: 'Redeploy',
      intro: 'Build, migrate, deploy. The startup probe holds traffic on the old revision until the new one can reach the database.',
      steps: [
        shl('TAG="$(git rev-parse --short HEAD)"'),
        g(['builds', 'submit'], [], [['--tag', n.image]]),
        g(['run', 'jobs', 'update'], [n.migrateJob], [R, ['--image', n.image]]),
        g(['run', 'jobs', 'execute'], [n.migrateJob], [R, ['--wait', null]]),
        g(['run', 'deploy'], [c.service], [R, ['--image', n.image]], 'Keeps every other setting from the current revision.'),
        shl(`bun smoke/smoke.ts https://${c.domain} --out smoke-$TAG.json`),
      ],
    },
    {
      id: 'rollback', title: 'Roll back',
      intro: 'Traffic goes back to a previous revision in seconds; nothing is rebuilt. Migrations only move forward, so they are written to work with the previous release too.',
      steps: [
        g(['run', 'revisions', 'list'], [], [['--service', c.service], R]),
        g(['run', 'services', 'update-traffic'], [c.service], [R, ['--to-revisions', `${c.service}-PREVIOUS=100`]]),
        g(['run', 'services', 'update-traffic'], [c.service], [R, ['--to-latest', null]], 'Once the fix is deployed.'),
      ],
    },
    {
      id: 'rotate', title: 'Rotate the database password',
      intro: 'Two logins take turns. The idle one gets a new password, a new revision starts on it, and only then is the old login\'s password replaced. Shown here for app_a to app_b; next time, swap them.',
      steps: [
        shl(`NEW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"`),
        g(['sql', 'users', 'set-password'], ['app_b'], [['--instance', c.sqlInstance], ['--password', '"$NEW"']]),
        shl(`printf '%s' "$NEW" | gcloud secrets versions add ${n.secretB} --data-file=-\nunset NEW\nV="$(gcloud secrets versions list ${n.secretB} --limit=1 --format='value(name)')"`),
        g(['run', 'services', 'update'], [c.service], [R, ['--update-env-vars', 'DATABASE_USER=app_b'], ['--update-secrets', `DATABASE_PASSWORD=${n.secretB}:$V`]], 'Traffic moves only after /readyz passes on the new credentials.'),
        g(['run', 'jobs', 'update'], [n.migrateJob], [R, ['--update-env-vars', 'DATABASE_USER=app_b'], ['--update-secrets', `DATABASE_PASSWORD=${n.secretB}:$V`]]),
        shl(`gcloud sql users set-password app_a --instance=${c.sqlInstance} --password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"`, 'Retire the old credential: a random password nobody stores.'),
        g(['secrets', 'versions', 'disable'], ['OLD_VERSION'], [['--secret', n.secretA]]),
      ],
    },
    {
      id: 'restore', title: 'Restore from backup',
      intro: 'Restore into a new instance at a point in time, check it, then point the service at it (or copy rows back). The original is never overwritten.',
      steps: [
        g(['sql', 'instances', 'clone'], [c.sqlInstance, `${c.sqlInstance}-restore`], [['--point-in-time', '"2026-01-01T12:00:00.000Z"']]),
        g(['sql', 'instances', 'describe'], [`${c.sqlInstance}-restore`], [['--format', `'value(ipAddresses[0].ipAddress)'`]]),
        g(['run', 'services', 'update'], [c.service], [R, ['--update-env-vars', 'DATABASE_HOST=RESTORED_PRIVATE_IP']], 'Only after the checks pass.'),
      ],
    },
    {
      id: 'access', title: 'Access',
      intro: 'Who can change what, and how to remove a person.',
      steps: [
        g(['projects', 'get-iam-policy'], [c.project], [['--flatten', 'bindings[].members'], ['--format', `'table(bindings.role,bindings.members,bindings.condition.title)'`]]),
        g(['projects', 'remove-iam-policy-binding'], [c.project], [['--member', `user:${c.contractor}`], ['--role', 'ROLE'], ['--all', null]]),
        g(['logging', 'read'], [`'protoPayload.authenticationInfo.principalEmail="${c.contractor}"'`], [['--freshness', '30d'], ['--limit', '50']], 'Every change I made, from Cloud Audit Logs.'),
      ],
    },
  ];
  return { plan, where, sections };
}

export function runbookMarkdown(rb) {
  const out = ['# VisitCompanion runbook', '', '## Where everything lives', '', '| What | Name | Region | Console |', '|---|---|---|---|', ...rb.where.map(([a, b, cc, d]) => `| ${a} | ${b} | ${cc} | ${d} |`), ''];
  for (const s of rb.sections) {
    out.push(`## ${s.title}`, '', s.intro, '', '```sh');
    for (const st of s.steps) out.push(...(st.note ? [`# ${st.note}`] : []), render(st));
    out.push('```', '');
  }
  return out.join('\n');
}
