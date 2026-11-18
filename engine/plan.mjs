// The deployment plan as data: every step is a gcloud command (checked against the gcloud CLI's
// own help by tools/verify-gcloud.mjs), a shell line, or SQL. Runs in Node and in the browser.

export const DEFAULTS = {
  project: 'premier-visitcompanion',
  region: 'us-east1',
  service: 'visitcompanion',
  domain: 'myvisitcompanion.com',
  network: 'default',
  sqlInstance: 'visitcompanion-pg',
  database: 'visitcompanion',
  tier: 'db-custom-1-3840',
  repo: 'visitcompanion',
  connector: 'visitcompanion-conn',
  connectorRange: '10.8.0.0/28',
  runtimeSa: 'visitcompanion-run',
  contractor: 'contractor@example.com',
  accessDays: 14,
  // choices the preflight checks look at
  domainMethod: 'lb', // 'lb' | 'mapping'
  vpcMode: 'connector', // 'connector' | 'direct'
  dbPublicIp: false,
  sslMode: 'ENCRYPTED_ONLY', // or 'ALLOW_UNENCRYPTED_AND_ENCRYPTED'
  pitr: true,
  deletionProtection: true,
  secretVersion: 'pinned', // 'pinned' | 'latest'
  runtimeIdentity: 'dedicated', // 'dedicated' | 'default'
  ingress: 'internal-and-cloud-load-balancing', // or 'all'
  bucketLockdown: true,
  startupProbe: true,
  twoUsers: true,
  contractorAccess: 'expiring', // 'expiring' | 'standing'
};

const g = (path, args = [], flags = [], note = '') => ({ type: 'gcloud', path, args, flags, note });
const shl = (text, note = '') => ({ type: 'shell', text, note });
const sql = (text, note = '') => ({ type: 'sql', text, note });

export function names(c) {
  const saEmail = c.runtimeIdentity === 'dedicated' ? `${c.runtimeSa}@${c.project}.iam.gserviceaccount.com` : 'PROJECT_NUMBER-compute@developer.gserviceaccount.com';
  return {
    saEmail,
    bucket: `${c.project}-visitcompanion-files`,
    image: `${c.region}-docker.pkg.dev/${c.project}/${c.repo}/${c.service}:$TAG`,
    pscRange: `google-managed-services-${c.network}`,
    secretA: 'visitcompanion-db-password-app-a',
    secretB: 'visitcompanion-db-password-app-b',
    secretAdmin: 'visitcompanion-db-password-postgres',
    lb: { ip: `${c.service}-ip`, neg: `${c.service}-neg`, backend: `${c.service}-backend`, urlmap: `${c.service}-urlmap`, redirect: `${c.service}-http-redirect`, cert: `${c.service}-cert`, tls: `${c.service}-tls`, https: `${c.service}-https-proxy`, http: `${c.service}-http-proxy`, frHttps: `${c.service}-https`, frHttp: `${c.service}-http` },
    migrateJob: `${c.service}-migrate`,
    subnet: `${c.service}-run-subnet`,
  };
}

const ver = (c) => (c.secretVersion === 'pinned' ? '1' : 'latest');

function vpcFlags(c, n) {
  return c.vpcMode === 'connector'
    ? [['--vpc-connector', c.connector], ['--vpc-egress', 'private-ranges-only']]
    : [['--network', c.network], ['--subnet', n.subnet], ['--vpc-egress', 'private-ranges-only']];
}

function appEnv(c) {
  return `DATABASE_HOST=$DB_PRIVATE_IP,DATABASE_NAME=${c.database},DATABASE_USER=app_a,DATABASE_SSL=require,STORAGE_BUCKET=${names(c).bucket},TEST_DATA_ONLY=true`;
}

export function buildPlan(input = {}) {
  const c = { ...DEFAULTS, ...input };
  const n = names(c);
  const R = ['--region', c.region];
  const phases = [];
  const phase = (id, title, why, steps) => phases.push({ id, title, why, steps });

  phase('project', 'Project, region and APIs', 'Everything lives in one region, so Cloud Run, Cloud SQL, the connector and the load balancer backend sit next to each other.', [
    g(['config', 'set'], ['project', c.project]),
    g(['services', 'enable'], ['run.googleapis.com', 'sqladmin.googleapis.com', 'secretmanager.googleapis.com', 'servicenetworking.googleapis.com', 'vpcaccess.googleapis.com', 'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'compute.googleapis.com']),
  ]);

  phase('network', 'Private services access for Cloud SQL', 'Cloud SQL private IP lives in a Google-managed network peered with yours. This reserves the range and creates the peering.', [
    g(['compute', 'addresses', 'create'], [n.pscRange], [['--global', null], ['--purpose', 'VPC_PEERING'], ['--prefix-length', '16'], ['--network', c.network]]),
    g(['services', 'vpc-peerings', 'connect'], [], [['--service', 'servicenetworking.googleapis.com'], ['--ranges', n.pscRange], ['--network', c.network]]),
  ]);

  const sqlFlags = [
    ['--database-version', 'POSTGRES_16'], ['--edition', 'ENTERPRISE'], ['--tier', c.tier], R,
    ['--network', `projects/${c.project}/global/networks/${c.network}`],
    [c.dbPublicIp ? '--assign-ip' : '--no-assign-ip', null],
    ['--ssl-mode', c.sslMode], ['--availability-type', 'zonal'], ['--backup-start-time', '08:00'], ['--retained-backups-count', '14'],
    ...(c.pitr ? [['--enable-point-in-time-recovery', null], ['--retained-transaction-log-days', '7']] : []),
    ...(c.deletionProtection ? [['--deletion-protection', null]] : []),
  ];
  phase('sql', 'Cloud SQL for PostgreSQL, private IP only', 'No public IP, TLS required, daily backups plus point-in-time recovery, and deletion protection. Passwords are generated in Cloud Shell and go straight into Secret Manager; nobody sees them.', [
    g(['sql', 'instances', 'create'], [c.sqlInstance], sqlFlags),
    g(['sql', 'databases', 'create'], [c.database], [['--instance', c.sqlInstance]]),
    shl(`ADMIN_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"\nAPP_A_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"${c.twoUsers ? `\nAPP_B_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"` : ''}`, 'Generated in Cloud Shell, never printed, pasted, emailed or committed.'),
    g(['sql', 'users', 'set-password'], ['postgres'], [['--instance', c.sqlInstance], ['--password', '"$ADMIN_PASS"']]),
    g(['sql', 'users', 'create'], ['app_a'], [['--instance', c.sqlInstance], ['--password', '"$APP_A_PASS"']]),
    ...(c.twoUsers ? [g(['sql', 'users', 'create'], ['app_b'], [['--instance', c.sqlInstance], ['--password', '"$APP_B_PASS"']], 'Second login for zero-downtime rotation. PostgreSQL has no dual passwords; gcloud\'s --retain-password is MySQL 8.0 only.')] : []),
    shl(`printf '%s' "$ADMIN_PASS" | gcloud secrets create ${n.secretAdmin} --replication-policy=user-managed --locations=${c.region} --data-file=-\nprintf '%s' "$APP_A_PASS" | gcloud secrets create ${n.secretA} --replication-policy=user-managed --locations=${c.region} --data-file=-${c.twoUsers ? `\nprintf '%s' "$APP_B_PASS" | gcloud secrets create ${n.secretB} --replication-policy=user-managed --locations=${c.region} --data-file=-` : ''}\nunset ADMIN_PASS APP_A_PASS APP_B_PASS`, 'Stored in this region only. The admin password is for setup and break-glass; the runtime account cannot read it.'),
    sql(`-- once, as postgres (Cloud SQL Studio), so both logins share one owner role\nCREATE ROLE vc_app NOLOGIN;\nGRANT vc_app TO app_a${c.twoUsers ? ', app_b' : ''};\nALTER ROLE app_a SET role = 'vc_app';${c.twoUsers ? `\nALTER ROLE app_b SET role = 'vc_app';` : ''}\nALTER DATABASE ${c.database} OWNER TO vc_app;\n\\c ${c.database}\nALTER SCHEMA public OWNER TO vc_app;`, 'Tables are owned by vc_app, so either login can run the app and migrations.'),
  ]);

  phase('storage', 'Cloud Storage bucket', 'Same region, uniform bucket-level access, public access blocked, and a 7-day soft-delete window for accidental deletes.', [
    g(['storage', 'buckets', 'create'], [`gs://${n.bucket}`], [['--location', c.region], ...(c.bucketLockdown ? [['--uniform-bucket-level-access', null], ['--public-access-prevention', null]] : []), ['--soft-delete-duration', '7d']]),
  ]);

  phase('identity', 'Runtime service account, least privilege', 'The app runs as its own service account with access to two secrets and one bucket, nothing project-wide.', [
    ...(c.runtimeIdentity === 'dedicated' ? [g(['iam', 'service-accounts', 'create'], [c.runtimeSa], [['--display-name', '"VisitCompanion runtime"']])] : []),
    g(['secrets', 'add-iam-policy-binding'], [n.secretA], [['--member', `serviceAccount:${n.saEmail}`], ['--role', 'roles/secretmanager.secretAccessor']]),
    ...(c.twoUsers ? [g(['secrets', 'add-iam-policy-binding'], [n.secretB], [['--member', `serviceAccount:${n.saEmail}`], ['--role', 'roles/secretmanager.secretAccessor']])] : []),
    g(['storage', 'buckets', 'add-iam-policy-binding'], [`gs://${n.bucket}`], [['--member', `serviceAccount:${n.saEmail}`], ['--role', 'roles/storage.objectUser']]),
  ]);

  phase('vpc', c.vpcMode === 'connector' ? 'Serverless VPC Access connector' : 'Subnet for Direct VPC egress', c.vpcMode === 'connector' ? 'Lets Cloud Run reach the private IP. Only private ranges go through it; everything else leaves directly.' : 'Cloud Run instances get addresses from this subnet; no connector VMs to pay for.', c.vpcMode === 'connector'
    ? [g(['compute', 'networks', 'vpc-access', 'connectors', 'create'], [c.connector], [R, ['--network', c.network], ['--range', c.connectorRange], ['--min-instances', '2'], ['--max-instances', '3'], ['--machine-type', 'e2-micro']])]
    : [g(['compute', 'networks', 'subnets', 'create'], [n.subnet], [['--network', c.network], R, ['--range', '10.9.0.0/26']])]);

  phase('build', 'Build the image', 'One image per commit, tagged with the commit hash, so every revision maps to exact code.', [
    g(['artifacts', 'repositories', 'create'], [c.repo], [['--repository-format', 'docker'], ['--location', c.region]]),
    shl('TAG="$(git rev-parse --short HEAD)"\nDB_PRIVATE_IP="$(gcloud sql instances describe ' + c.sqlInstance + ' --format=\'value(ipAddresses[0].ipAddress)\')"'),
    g(['builds', 'submit'], [], [['--tag', n.image]]),
  ]);

  const runFlags = (extra = []) => [['--image', n.image], R, ['--service-account', n.saEmail], ...vpcFlags(c, n), ['--set-env-vars', appEnv(c)], ['--set-secrets', `DATABASE_PASSWORD=${n.secretA}:${ver(c)}`], ...extra];
  phase('migrate', 'Migrations as a Cloud Run job', 'Drizzle migrations run once per release, from the same image, before traffic moves.', [
    g(['run', 'jobs', 'create'], [n.migrateJob], [...runFlags(), ['--command', 'bun'], ['--args', 'run,migrate']]),
    g(['run', 'jobs', 'execute'], [n.migrateJob], [R, ['--wait', null]]),
  ]);

  phase('deploy', 'Deploy, private first', 'The first revision needs an identity token to call, so smoke tests run before anything is public. The startup probe hits /readyz, so a revision that cannot log in to the database never takes traffic.', [
    g(['run', 'deploy'], [c.service], runFlags([
      ...(c.startupProbe ? [['--startup-probe', 'httpGet.path=/readyz,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=5,failureThreshold=6']] : []),
      ['--ingress', 'all'], ['--no-allow-unauthenticated', null], ['--cpu-boost', null], ['--min-instances', '0'], ['--max-instances', '4'],
    ])),
    shl(`bun smoke/smoke.ts "$(gcloud run services describe ${c.service} --region=${c.region} --format='value(status.url)')" --token "$(gcloud auth print-identity-token)" --out smoke-run-app.json`, 'Smoke test against the private run.app URL.'),
  ]);

  if (c.domainMethod === 'lb') {
    const L = n.lb;
    phase('domain', `${c.domain} through a global external Application Load Balancer`, 'A Google-managed certificate on the load balancer, TLS 1.2 minimum, HTTP redirected to HTTPS. Then the service accepts traffic only through the load balancer.', [
      g(['compute', 'addresses', 'create'], [L.ip], [['--global', null]]),
      g(['compute', 'network-endpoint-groups', 'create'], [L.neg], [R, ['--network-endpoint-type', 'serverless'], ['--cloud-run-service', c.service]]),
      g(['compute', 'backend-services', 'create'], [L.backend], [['--global', null], ['--load-balancing-scheme', 'EXTERNAL_MANAGED']]),
      g(['compute', 'backend-services', 'add-backend'], [L.backend], [['--global', null], ['--network-endpoint-group', L.neg], ['--network-endpoint-group-region', c.region]]),
      g(['compute', 'url-maps', 'create'], [L.urlmap], [['--default-service', L.backend]]),
      g(['compute', 'ssl-certificates', 'create'], [L.cert], [['--domains', `${c.domain},www.${c.domain}`], ['--global', null]]),
      g(['compute', 'ssl-policies', 'create'], [L.tls], [['--profile', 'MODERN'], ['--min-tls-version', '1.2']]),
      g(['compute', 'target-https-proxies', 'create'], [L.https], [['--url-map', L.urlmap], ['--ssl-certificates', L.cert], ['--ssl-policy', L.tls]]),
      g(['compute', 'forwarding-rules', 'create'], [L.frHttps], [['--global', null], ['--load-balancing-scheme', 'EXTERNAL_MANAGED'], ['--address', L.ip], ['--target-https-proxy', L.https], ['--ports', '443']]),
      shl(`gcloud compute url-maps import ${L.redirect} --global --source=- <<'EOF'\nname: ${L.redirect}\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\nEOF`),
      g(['compute', 'target-http-proxies', 'create'], [L.http], [['--url-map', L.redirect]]),
      g(['compute', 'forwarding-rules', 'create'], [L.frHttp], [['--global', null], ['--load-balancing-scheme', 'EXTERNAL_MANAGED'], ['--address', L.ip], ['--target-http-proxy', L.http], ['--ports', '80']]),
      shl(`gcloud compute addresses describe ${L.ip} --global --format='value(address)'\n# At your DNS host: A records for ${c.domain} and www.${c.domain} to this address.\n# The certificate turns ACTIVE once DNS resolves to it:\ngcloud compute ssl-certificates describe ${L.cert} --global --format='value(managed.status)'`),
      g(['run', 'services', 'update'], [c.service], [R, ['--ingress', c.ingress]]),
      g(['run', 'services', 'add-iam-policy-binding'], [c.service], [R, ['--member', 'allUsers'], ['--role', 'roles/run.invoker']], 'Public through the load balancer only; the app does its own sign-in. If an organization policy blocks allUsers, deploy with --no-invoker-iam-check instead.'),
    ]);
  } else {
    phase('domain', `${c.domain} through a Cloud Run domain mapping`, 'Simplest option, but Cloud Run domain mappings are a Preview feature.', [
      g(['beta', 'run', 'domain-mappings', 'create'], [], [['--service', c.service], ['--domain', c.domain], R], 'Fully managed Cloud Run needs the beta command group for this: the GA command is for Cloud Run for Anthos.'),
      g(['run', 'services', 'add-iam-policy-binding'], [c.service], [R, ['--member', 'allUsers'], ['--role', 'roles/run.invoker']]),
    ]);
  }

  phase('verify', 'Verify and smoke test', 'Configuration read back from the API, then the same smoke tests through the domain.', [
    g(['sql', 'instances', 'describe'], [c.sqlInstance], [['--format', `'value(settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.sslMode,settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.deletionProtectionEnabled)'`]]),
    g(['run', 'services', 'describe'], [c.service], [R, ['--format', `'value(spec.template.spec.serviceAccountName,metadata.annotations."run.googleapis.com/ingress")'`]]),
    g(['storage', 'buckets', 'describe'], [`gs://${n.bucket}`], [['--format', `'value(uniform_bucket_level_access,public_access_prevention)'`]]),
    shl(`bun smoke/smoke.ts https://${c.domain} --out smoke-domain.json\ncurl -s -o /dev/null -w '%{http_code}\\n' "$(gcloud run services describe ${c.service} --region=${c.region} --format='value(status.url)')/healthz"   # expect 404: run.app closed`),
  ]);

  phase('drill', 'Backup and restore drill', 'Restore to a point in time into a new instance, compare row counts and checksums with the source at that moment, then delete the copy.', [
    g(['sql', 'backups', 'create'], [], [['--instance', c.sqlInstance]]),
    shl(`TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"   # after writing the drill's marker rows`),
    g(['sql', 'instances', 'clone'], [c.sqlInstance, `${c.sqlInstance}-drill`], [['--point-in-time', '"$TS"']]),
    sql(`-- on both instances, compare\nSELECT count(*), md5(string_agg(id::text || patient_ref || visit_date::text, ',' ORDER BY id)) FROM visits WHERE created_at <= '$TS';`),
    g(['sql', 'instances', 'patch'], [`${c.sqlInstance}-drill`], [['--no-deletion-protection', null]]),
    g(['sql', 'instances', 'delete'], [`${c.sqlInstance}-drill`]),
  ]);

  const expiry = `request.time < timestamp('EXPIRY')`;
  phase('access', 'My access, and handing it back', 'Granted by your admin to my own Google account, expiring by itself; listed here so removing it is one copy-paste.', [
    ...['roles/run.admin', 'roles/cloudsql.admin', 'roles/secretmanager.admin', 'roles/storage.admin', 'roles/compute.networkAdmin', 'roles/compute.loadBalancerAdmin', 'roles/vpcaccess.admin', 'roles/artifactregistry.admin', 'roles/cloudbuild.builds.editor', 'roles/iam.serviceAccountAdmin', 'roles/iam.serviceAccountUser', 'roles/serviceusage.serviceUsageAdmin'].map((role) =>
      g(['projects', 'add-iam-policy-binding'], [c.project], [['--member', `user:${c.contractor}`], ['--role', role], ...(c.contractorAccess === 'expiring' ? [['--condition', `"expression=${expiry},title=contractor-${c.accessDays}d"`]] : [])])),
  ]);

  return { config: c, names: n, phases };
}

function q(v) {
  if (v === null) return '';
  return /^[\w@./:,=$"'-]+$/.test(v) || v.startsWith('"') || v.startsWith("'") ? v : `'${v}'`;
}

export function render(step) {
  if (step.type !== 'gcloud') return step.text;
  const head = ['gcloud', ...step.path, ...step.args].join(' ');
  const flags = step.flags.map(([k, v]) => (v === null ? k : `${k}=${q(v)}`));
  if (flags.length <= 2) return [head, ...flags].join(' ');
  return [head, ...flags].join(' \\\n  ');
}

export function renderPlan(plan) {
  return plan.phases.map((p, i) => [`# ${i + 1}. ${p.title}`, `# ${p.why}`, ...p.steps.map((s) => (s.type === 'sql' ? `# SQL (Cloud SQL Studio):\n${s.text.split('\n').map((l) => `#   ${l}`).join('\n')}` : (s.note ? `# ${s.note}\n` : '') + render(s))), ''].join('\n')).join('\n');
}

export function gcloudSteps(plan) {
  const out = [];
  for (const p of plan.phases) for (const s of p.steps) if (s.type === 'gcloud') out.push({ phase: p.id, ...s });
  return out;
}
