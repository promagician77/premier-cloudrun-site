# VisitCompanion on Cloud Run: deployment plan and drills

Prepared by Santiago.

A static, single-page demo. It holds a deployment plan for a Bun + Hono app with Drizzle and PostgreSQL on Cloud Run, Cloud SQL (private IP), Cloud Storage and Secret Manager. You can change the settings and watch 15 preflight checks respond. The page also has the results of three drills run against a stand-in app with the same stack and test data only: smoke tests, a point-in-time restore and a database password rotation under load. It finishes with the runbook (redeploy, roll back, rotate, restore, access) and how the database password and contractor access are handled.

Deploy the folder as-is (Vercel: framework none, no build, output `.`). `vercel.json` sends `X-Robots-Tag: noindex, nofollow` and the page carries a robots noindex tag. Nothing on the page talks to Google Cloud.

## Measured

- gcloud: the plan and runbook were checked against Google Cloud SDK 570.0.0's own `--help`. That covers 192 commands (53 distinct), 143 flags and 15 enum values, with 0 problems. The one step that needs `gcloud beta` is Cloud Run domain mapping, which the default plan does not use. Its help text says so: "For domain mapping support with fully managed Cloud Run, use gcloud beta run domain-mappings create."
- Preflight: the default plan passes all 15 checks. Each setting on the page trips exactly its own check (13 engine tests).
- Smoke drill on Bun 1.4.4 and PostgreSQL 16.15 with TLS only:
  - 10 of 11 checks pass. HTTPS redirect is n/a without the load balancer.
  - A connection without TLS was refused.
  - First healthy response after 110 ms.
  - p95 read latency was 4.4 ms locally.
  - SIGTERM with a 3 MB upload in flight: the upload completed (201) and the process exited 0 after 24 ms.
  - 42 JSON log lines contained no test patient references or visit IDs.
  - The Cloud Storage adapter made 1 metadata-server token request and had 0 auth failures.
- Restore drill:
  - Base backup of 5,000 visits, then 1,500 more visits written after it.
  - A DELETE removed 4,652 visits and DROP TABLE removed `visit_files`.
  - Restoring to the recorded time in a new data directory brought back 6,500 of 6,500 visits and 1,645 of 1,645 file records, with identical checksums, in 0.5 s.
  - PostgreSQL logged "recovery stopping before commit of transaction 744".
  - The app's login worked on the copy.
- Rotation drill (40 requests a second for 30 s, new revision live 15 s after the password step):
  - Changing the live login's password and then redeploying: 521 of 1,189 requests failed (HTTP 500), from 6.0 s to 19.2 s.
  - Two logins taking turns: 0 of 1,190 failed.
- Tests: 13 engine tests (Node) and 6 app tests (Bun) pass. 21 of 21 bugs planted one at a time were caught.
- Site: 30 of 30 headless-Chrome checks pass:
  - preflight toggles
  - region rewrite
  - `deploy.sh` and `runbook.md` downloads
  - chart tooltips
  - tables
  - IDs and anchors
  - layout at 390px

  axe-core found 0 violations on desktop and mobile.

## Not measured

- Premier Medical's app, guide and smoke checklist. I haven't seen them. The stand-in app uses the same stack, and the plan uses its own resource names until the guide's names replace them.
- Anything in a Google Cloud project. No command was run against Google. Flags were checked against the CLI's help, not executed.
- Timings on Google Cloud. Deploy, certificate provisioning, restore and cold-start times there will differ from this machine.
- The Docker image. The Dockerfile is in the kit; it was not built here.
- Organization policies (for example, one that blocks `allUsers` on Cloud Run). The plan's domain step notes the `--no-invoker-iam-check` alternative.
- Legal or compliance advice. The BAA with Google and Premier Medical's HIPAA program decide what is required. The page cites Google's published guidance only.
