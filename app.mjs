import { buildPlan, render, renderPlan } from './engine/plan.mjs';
import { preflight } from './engine/checks.mjs';
import { runbook, runbookMarkdown } from './engine/runbook.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const D = await (await fetch('data/results.json')).json();
const ROT = D.rotation;
const A = ROT['change-then-redeploy'];
const B = ROT['two-users'];

// ---------- Rotation chart ----------
$('#evidence-lede').textContent = `The stand-in app, a TLS-only PostgreSQL 16 server, ${40} requests a second for ${ROT.totalSeconds} seconds, half writes and half reads. Pooled connections were recycled every ${ROT.poolLifetimeSeconds} seconds to stand in for Cloud Run starting new instances, and the new revision went live ${ROT.deploySeconds} seconds after the password step. PostgreSQL keeps one password per login, and Cloud SQL's dual-password option (--retain-password) is MySQL 8.0 only, so this is the choice you actually have.`;
function chart() {
  const W = 1000;
  const laneH = 92;
  const gap = 74;
  const left = 0;
  const top = 50;
  const secs = ROT.totalSeconds;
  const bw = W / secs;
  const max = Math.max(...[...A.series, ...B.series].map((s) => s.ok + s.failed));
  const lanes = [
    ['Change the password, then redeploy', A, `${fmt(A.failed)} of ${fmt(A.requests)} requests failed, between ${A.firstFailure.toFixed(0)} s and ${A.lastFailure.toFixed(0)} s`],
    ['Two logins, retire the old one last', B, `${fmt(B.failed)} of ${fmt(B.requests)} requests failed`],
  ];
  let svg = `<svg viewBox="0 0 ${W} ${top + 2 * laneH + gap + 40}" role="img" aria-labelledby="rot-title rot-desc"><title id="rot-title">Requests served and failed per second during two password rotations</title><desc id="rot-desc">${esc(lanes.map((l) => `${l[0]}: ${l[2]}.`).join(' '))}</desc>`;
  lanes.forEach(([title, r, sub], li) => {
    const y0 = top + li * (laneH + gap);
    svg += `<text class="lane-t" x="${left}" y="${y0 - 30}">${esc(title)}</text><text class="lane-s" x="${W}" y="${y0 - 30}" text-anchor="end">${esc(sub)}</text>`;
    r.series.forEach((s) => {
      const x = left + s.s * bw + 1;
      const w = bw - 2;
      const hOk = (laneH * s.ok) / max;
      const hBad = (laneH * s.failed) / max;
      if (s.ok) svg += `<rect x="${x.toFixed(1)}" y="${(y0 + laneH - hOk).toFixed(1)}" width="${w.toFixed(1)}" height="${hOk.toFixed(1)}" rx="2" fill="var(--served)"/>`;
      if (s.failed) svg += `<rect x="${x.toFixed(1)}" y="${(y0 + laneH - hOk - hBad - (s.ok ? 2 : 0)).toFixed(1)}" width="${w.toFixed(1)}" height="${hBad.toFixed(1)}" rx="2" fill="var(--failed)"/>`;
      svg += `<rect class="hit" data-lane="${li}" data-s="${s.s}" x="${(left + s.s * bw).toFixed(1)}" y="${y0 - 4}" width="${bw.toFixed(1)}" height="${laneH + 8}"/>`;
    });
    r.events.forEach((e, ei) => {
      const x = left + e.t * bw;
      const short = e.what.startsWith('ALTER') ? 'password step' : e.what.startsWith('new revision starting') ? '' : e.what.startsWith('readiness') ? 'new revision live' : e.what.startsWith('old revision') ? '' : e.what.startsWith('app_a password') ? '' : '';
      svg += `<line class="evt" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y0 - (short ? 18 : 4)}" y2="${y0 + laneH + 4}"/>`;
      if (short) svg += `<text class="evt-t" x="${(x + 5).toFixed(1)}" y="${y0 - 8}">${esc(short)}</text>`;
      void ei;
    });
    svg += `<line x1="0" x2="${W}" y1="${y0 + laneH + 0.5}" y2="${y0 + laneH + 0.5}" stroke="var(--rule)"/>`;
  });
  const yAxis = top + 2 * laneH + gap + 20;
  for (let s = 0; s <= secs; s += 5) svg += `<text class="axis" x="${(left + s * bw).toFixed(1)}" y="${yAxis}" text-anchor="${s === 0 ? 'start' : s === secs ? 'end' : 'middle'}">${s} s</text>`;
  svg += '</svg>';
  $('#rot-chart').innerHTML = svg;
  const tip = $('#rot-tip');
  const show = (el) => {
    const r = lanes[Number(el.dataset.lane)][1];
    const s = r.series[Number(el.dataset.s)];
    tip.innerHTML = `<strong>${s.s}-${s.s + 1} s</strong><br>${s.ok} served, ${s.failed} failed`;
    tip.hidden = false;
    const b = el.getBoundingClientRect();
    const host = $('#evidence').getBoundingClientRect();
    tip.style.left = `${Math.min(b.left - host.left, host.width - 150)}px`;
    tip.style.top = `${b.top - host.top - 46}px`;
  };
  for (const el of document.querySelectorAll('#rot-chart .hit')) {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
}
chart();
$('#rot-steps').innerHTML = [['Change the password, then redeploy', A], ['Two logins, retire the old one last', B]].map(([t, r]) => `<div><h3>${esc(t)}</h3><ol class="story">${r.events.map((e) => `<li><strong>${e.t.toFixed(1)} s</strong>: ${esc(e.what)}</li>`).join('')}</ol><p>${fmt(r.requests)} requests, ${fmt(r.failed)} failed${r.failed ? ` (all HTTP ${Object.keys(r.statusCounts).join(', ')}: "password authentication failed" on new connections)` : ''}.</p></div>`).join('');

// ---------- Plan builder ----------
const form = $('#controls');
function readConfig() {
  const f = new FormData(form);
  const v = (k) => f.get(k);
  return {
    project: (v('project') || 'premier-visitcompanion').trim(), region: v('region'), domain: (v('domain') || 'myvisitcompanion.com').trim(), service: (v('service') || 'visitcompanion').trim(),
    domainMethod: v('domainMethod'), vpcMode: v('vpcMode'), secretVersion: v('secretVersion'), runtimeIdentity: v('runtimeIdentity'), ingress: v('ingress'), contractorAccess: v('contractorAccess'),
    dbPublicIp: f.has('dbPublicIp'), sslMode: f.has('sslAllow') ? 'ALLOW_UNENCRYPTED_AND_ENCRYPTED' : 'ENCRYPTED_ONLY', pitr: f.has('pitr'), deletionProtection: f.has('deletionProtection'), bucketLockdown: f.has('bucketLockdown'), startupProbe: f.has('startupProbe'), twoUsers: f.has('twoUsers'),
  };
}
const ICON = { pass: '✓', warn: '!', fail: '×' };
const WORD = { pass: 'Pass', warn: 'Check', fail: 'Fail' };
function code(text, isSql = false) {
  return `<pre class="code" tabindex="0">${text.split('\n').map((l) => (l.trim().startsWith('#') || (isSql && l.trim().startsWith('-- ')) ? `<span class="c">${esc(l)}</span>` : esc(l))).join('\n')}</pre>`;
}
let current = null;
function renderPlanUI() {
  const cfg = readConfig();
  const pf = preflight(cfg);
  current = { cfg, plan: pf.plan };
  $('#pre-sum').textContent = pf.fails || pf.warns ? `${pf.fails} failing, ${pf.warns} to check, ${pf.results.length - pf.fails - pf.warns} passing` : `All ${pf.results.length} preflight checks pass`;
  const rank = { fail: 0, warn: 1, pass: 2 };
  $('#pre-list').innerHTML = [...pf.results].sort((a, b) => rank[a.status] - rank[b.status]).map((r) => `<li data-check="${r.id}" data-status="${r.status}"><span class="ic ${r.status}" aria-hidden="true">${ICON[r.status]}</span><span><span class="sr">${WORD[r.status]}: </span>${esc(r.label)}<span class="d">${esc(r.detail)}</span>${r.status !== 'pass' ? `<span class="w">${esc(r.why)}</span>` : ''}</span></li>`).join('');
  $('#phases').innerHTML = pf.plan.phases.map((p, i) => {
    const n = p.steps.filter((s) => s.type === 'gcloud').length;
    const body = p.steps.map((s) => (s.type === 'sql' ? `<p class="sql-note">SQL, once, in Cloud SQL Studio</p>${code(s.text, true)}` : code((s.note ? `# ${s.note}\n` : '') + render(s)))).join('');
    return `<li data-phase="${p.id}"><details${i === 0 ? '' : ''}><summary><span class="pt">${esc(p.title)}</span><span class="pn">${n} gcloud command${n === 1 ? '' : 's'}</span><span class="pw">${esc(p.why)}</span></summary><div class="body">${body}</div></details></li>`;
  }).join('');
  renderRunbook(cfg);
  renderRoles(pf.plan);
}
form.addEventListener('input', renderPlanUI);
form.addEventListener('change', renderPlanUI);
form.addEventListener('submit', (e) => e.preventDefault());
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
$('#dl-sh').addEventListener('click', () => download('deploy.sh', `#!/usr/bin/env bash\n# Deployment plan for ${current.cfg.service} in ${current.cfg.project} (${current.cfg.region}).\n# Run phase by phase in Cloud Shell, reading each step first. Prepared by Santiago.\nset -euo pipefail\n\n${renderPlan(current.plan)}`));

// ---------- Runbook ----------
let rbCurrent = null;
function renderRunbook(cfg) {
  const rb = runbook(cfg);
  rbCurrent = rb;
  $('#where').innerHTML = `<thead><tr><th scope="col">What</th><th scope="col">Name</th><th scope="col">Region</th></tr></thead><tbody>${rb.where.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="mono">${esc(b)}</td><td class="nw">${esc(c)}</td></tr>`).join('')}</tbody>`;
  $('#rb-sections').innerHTML = rb.sections.map((s) => `<div class="rb" data-section="${s.id}"><h3>${esc(s.title)}</h3><p>${esc(s.intro)}</p>${code(s.steps.map((st) => (st.note ? `# ${st.note}\n` : '') + render(st)).join('\n'))}</div>`).join('');
}
$('#dl-md').addEventListener('click', () => download('runbook.md', runbookMarkdown(rbCurrent)));

// ---------- Access ----------
const ROLE_WHY = {
  'roles/run.admin': 'Deploy the service and migration job; move traffic; make the service public through the load balancer',
  'roles/cloudsql.admin': 'Create the instance, database and logins; backups and the restore drill',
  'roles/secretmanager.admin': 'Create the secrets and grant the app access to two of them',
  'roles/storage.admin': 'Create the bucket and grant the app access to it; Cloud Build source uploads',
  'roles/compute.networkAdmin': 'Reserve the private services range and connect the peering for Cloud SQL',
  'roles/compute.loadBalancerAdmin': 'Static IP, serverless NEG, backend, URL maps, certificate, proxies',
  'roles/vpcaccess.admin': 'The VPC connector',
  'roles/artifactregistry.admin': 'The image repository',
  'roles/cloudbuild.builds.editor': 'Build the image from your repository',
  'roles/iam.serviceAccountAdmin': 'Create the app\'s runtime service account',
  'roles/iam.serviceAccountUser': 'Deploy the service to run as that account',
  'roles/serviceusage.serviceUsageAdmin': 'Turn on the APIs (not needed if you turn them on)',
};
function renderRoles(plan) {
  const ph = plan.phases.find((p) => p.id === 'access');
  $('#roles').innerHTML = `<thead><tr><th scope="col">Role</th><th scope="col">What it's for</th><th scope="col">Condition</th></tr></thead><tbody>${ph.steps.map((s) => { const role = s.flags.find(([k]) => k === '--role')[1]; const cond = s.flags.find(([k]) => k === '--condition'); return `<tr><td class="mono">${esc(role)}</td><td>${esc(ROLE_WHY[role] || '')}</td><td class="nw">${cond ? `expires after ${plan.config.accessDays} days` : '<strong>none: standing access</strong>'}</td></tr>`; }).join('')}</tbody>`;
}
$('#pw-list').innerHTML = [
  'Generated in Cloud Shell with openssl, held in a shell variable, written straight to Cloud SQL and to Secret Manager, then unset. Never printed, pasted into chat, emailed or committed. I don\'t keep a copy.',
  'Stored in Secret Manager in your region. Only the app\'s own service account can read the two app secrets; the postgres admin password is for setup and break-glass, and the app cannot read it.',
  'Given to Cloud Run as a secret reference pinned to a version number, not "latest", so every instance of a revision holds the same password.',
  `Rotated with two logins taking turns, as in the drill above: ${fmt(B.failed)} failed requests, against ${fmt(A.failed)} for changing the live password and redeploying.`,
  'The database accepts TLS connections only and has no public IP, so the password alone is not enough to reach it.',
].map((x) => `<li>${esc(x)}</li>`).join('');
$('#access-list').innerHTML = [
  'My own Google account with 2-step verification, added by your admin. No shared logins and no service account keys.',
  'Named roles instead of Owner or Editor, each with an IAM condition that expires on its own after the project.',
  'Everything I change shows up in Cloud Audit Logs under my name; the runbook has the query.',
  'At handover: I send the list of what I created, your admin removes the bindings (one command each, in the runbook), and I confirm I hold no credentials.',
  'If you prefer just-in-time access, Privileged Access Manager can grant the same roles per request with your approval.',
].map((x) => `<li>${esc(x)}</li>`).join('');

renderPlanUI();

// ---------- Drills ----------
const S = D.smoke;
const SM = S.smoke;
$('#drills-lede').textContent = `Run on ${D.bun ? `Bun ${D.bun}` : 'Bun'} and ${D.postgres.replace('postgres (PostgreSQL) ', 'PostgreSQL ')}, with a stand-in app built on your stack: Hono, Drizzle migrations, postgres.js, and Cloud Storage reached through its JSON API with a token from the metadata server, which is how the app gets credentials on Cloud Run without a key file. Test data only.`;
$('#smoke-lede').textContent = `The same runner I'd point at your service: first at the private run.app URL with an identity token, then at ${'https://myvisitcompanion.com'}. Locally: ${SM.passed} passed, ${SM.failed} failed, ${SM.skipped} not applicable (the HTTPS redirect needs the load balancer).`;
$('#smoke-table').innerHTML = `<thead><tr><th scope="col">Result</th><th scope="col">Check</th><th scope="col">Detail</th><th scope="col" class="n">Time</th></tr></thead><tbody>${SM.checks.map((c) => `<tr data-check="${c.id}"><td><span class="ic ${c.ok === true ? 'pass' : c.ok === false ? 'fail' : 'warn'}" aria-hidden="true">${c.ok === true ? '✓' : c.ok === false ? '×' : '–'}</span> ${c.ok === true ? 'Pass' : c.ok === false ? 'Fail' : 'n/a'}</td><td>${esc(c.label)}</td><td>${esc(c.detail)}</td><td class="n">${c.ms} ms</td></tr>`).join('')}</tbody>`;
$('#smoke-facts').innerHTML = [
  `A connection without TLS was refused: ${S.plainTextRefused ? 'yes' : 'no'}. The drill database accepts TLS only, like Cloud SQL's ENCRYPTED_ONLY.`,
  `Migrations ran as a separate one-off process before the app started, the way a Cloud Run job would run them.`,
  `Startup to first healthy response: ${S.coldStartMs} ms on this machine.`,
  `SIGTERM with a 3 MB upload in flight: the upload finished (HTTP ${S.drain.inflightStatus}) and the process exited with code ${S.drain.exitCode} after ${S.drain.stopMs} ms. Cloud Run sends SIGTERM before stopping an instance.`,
  `Logs are JSON for Cloud Logging and name the route pattern, not the URL: "${JSON.parse(S.logs.sample).route}". Test patient references or visit IDs in ${S.logs.lines} log lines: ${S.logs.leaked ? 'found' : 'none'}.`,
  `Cloud Storage calls: ${S.gcs.tokenCalls} metadata token request, ${S.gcs.objects} object stored, ${S.gcs.authFailures} rejected.`,
].map((x) => `<li>${esc(x)}</li>`).join('');
const P = D.pitr;
$('#pitr-story').innerHTML = [
  `<strong>Base backup</strong> of ${fmt(P.atTarget.visits - 1500)} test visits (${(P.baseBackupMs / 1000).toFixed(1)} s), with WAL archiving on, as Cloud SQL's automated backups and point-in-time recovery do.`,
  `<strong>${fmt(1500)} more visits</strong> written after the backup: only the archived WAL can bring these back.`,
  `<strong>Target time</strong> recorded with a checksum of every row: ${fmt(P.atTarget.visits)} visits and ${fmt(P.atTarget.files)} file records.`,
  `<strong>The mistake</strong>: a DELETE that removed ${fmt(P.mistake.deletedVisits)} visits, then DROP TABLE visit_files. ${fmt(P.afterMistake.visits)} visits left.`,
  `<strong>Restore into a new instance</strong> at the target time (${(P.restoreMs / 1000).toFixed(1)} s here): ${fmt(P.restored.visits)} visits and ${fmt(P.restored.files)} file records, checksums ${P.match ? 'identical' : 'different'}. PostgreSQL's log: "${esc(P.recoveryLog.replace(/, time .*/, ''))}".`,
  `<strong>The app's own login works on the copy</strong>: ${P.appLoginOnRestored ? 'yes' : 'no'}. On Cloud SQL this is gcloud sql instances clone with --point-in-time, and the original is never overwritten.`,
].map((x) => `<li>${x}</li>`).join('');
$('#rot-summary').textContent = `Shown at the top of the page: ${fmt(A.failed)} of ${fmt(A.requests)} requests failed when the live login's password changed before the new revision was up; ${fmt(B.failed)} of ${fmt(B.requests)} with two logins. The new revision also had to pass /readyz before traffic moved, which is what Cloud Run's startup probe and deploy health check do. Tables stay owned by one shared role (${ROT.tableOwner}), so either login reads and writes everything.`;

// ---------- Measured ----------
const G = D.gcloud;
const T = D.tests;
const M = D.mutation;
const Q = D.qa;
$('#measured-list').innerHTML = [
  `${G.commands} gcloud commands in the plan and runbook (${G.distinctCommands} distinct) checked against ${G.gcloudVersion}'s help: ${G.flagChecks} flags and ${G.valueChecks} values, ${G.failures.length} problems. The one Preview step, domain mapping, needs gcloud beta.`,
  `Smoke runner: ${SM.passed} of ${SM.checks.length - SM.skipped} applicable checks pass on the stand-in app.`,
  `Restore drill: ${fmt(P.restored.visits)} of ${fmt(P.atTarget.visits)} visits and ${fmt(P.restored.files)} of ${fmt(P.atTarget.files)} file records back, checksums identical.`,
  `Rotation drill: ${fmt(A.failed)} failed requests changing the live password, ${fmt(B.failed)} with two logins.`,
  `${T.engine.pass + T.app.pass} tests pass${M ? `; ${M.caught} of ${M.applied} bugs planted one at a time were caught` : ''}.`,
  Q ? `This page: ${Q.passed} of ${Q.total} headless-Chrome checks, ${Q.axeViolations} accessibility violations (axe-core).` : 'This page: run tools/site-qa.mjs.',
].map((x) => `<li>${esc(x)}</li>`).join('');
$('#not-measured-list').innerHTML = [
  'Your app and your guide. I haven\'t seen them; the stand-in app has the same stack, and the plan follows its own names until I see yours.',
  'Anything in a Google Cloud project. No command was run against Google; flags were checked against the CLI\'s help, not executed.',
  'Cloud Run and Cloud SQL timings. Deploy, certificate and restore times on Google differ from this machine.',
  'The Docker image. The Dockerfile is in the kit; there is no Docker on this machine to build it.',
  'Whether an organization policy blocks allUsers on Cloud Run. If it does, the plan notes the --no-invoker-iam-check alternative.',
  'Legal or compliance advice. Your BAA with Google and your HIPAA program decide what is required.',
].map((x) => `<li>${esc(x)}</li>`).join('');

document.documentElement.dataset.ready = 'true';
