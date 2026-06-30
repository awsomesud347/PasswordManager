# Architecture

This document describes the design of Glasshouse and the rationale behind the major decisions. It assumes you have read the [README](../README.md) for the high-level summary.

The guiding principle throughout: **the application is cloud-agnostic, and the deployment is infrastructure-as-code.** These are kept strictly separate so that one codebase runs identically whether self-hosted on a single box or deployed on a hardened AWS stack.

---

## 1. The zero-knowledge model

The server is designed to be useless to an attacker who fully compromises it. It never sees the master password, the encryption key, or any plaintext credential. It stores only ciphertext and a verifier.

### Key derivation and split

All cryptography runs in the browser via the WebCrypto API and a WASM Argon2 implementation (`hash-wasm`).

1. The master password and a per-user salt are fed to **Argon2id** (64 MB memory, 3 iterations, parallelism 1).
2. The resulting key material is passed through **HKDF** to derive two independent keys via domain separation:
   - **Encryption key** — used with **AES-256-GCM** to encrypt the vault. Imported as a non-extractable `CryptoKey`, so the browser will not export its raw bytes even to the page's own JavaScript. It never leaves the device.
   - **Auth key** — sent to the server exactly once per session to prove identity.

The reason for deriving two keys from one master secret, rather than asking the user for two secrets, is **domain separation**: the key that proves identity to the server and the key that decrypts the vault must never be the same value, or the server would receive material related to the decryption key. HKDF with distinct info parameters gives two cryptographically independent keys from the single high-entropy Argon2 output.

### What the server stores

The auth key is **not** stored. On registration the server peppers the auth key and hashes it with Argon2 (`argon2-cffi`), producing a **verifier**. On login the server repeats the operation and compares. This means a database compromise yields verifiers, not auth keys — and even the auth key, if it leaked, cannot decrypt the vault, because the encryption key never left the browser.

The vault is stored as a single opaque **encrypted blob** plus its IV and a version counter.

### Consequence: no recovery

If the master password is lost, the vault is unrecoverable. The server has no key escrow and no reset path, because it has nothing capable of decrypting the blob. This is an intentional property of a zero-knowledge design, not an omission.

---

## 2. Data model

A single `users` table holds everything. The vault is one encrypted blob per user rather than per-entry rows, because the server must not be able to distinguish or count individual credentials.

| Column          | Type      | Notes                                                        |
|-----------------|-----------|-------------------------------------------------------------|
| `id`            | String    | UUID primary key                                            |
| `email`         | String    | Unique, indexed — the login identifier                      |
| `salt`          | String    | Per-user KDF salt                                           |
| `kdf_params`    | Text      | JSON of the Argon2 parameters used, stored for forward-compat |
| `verifier`      | String    | Peppered Argon2 hash of the auth key — never the auth key   |
| `vault_blob`    | Text      | AES-256-GCM ciphertext of the entire vault                 |
| `iv`            | String    | Initialization vector for the blob                          |
| `vault_version` | Integer   | Monotonic counter for optimistic concurrency control       |
| `created_at`    | DateTime  | Server timestamp                                            |

Storing `kdf_params` per user matters for the future: if the Argon2 parameters are ever strengthened, existing users can still be derived with the parameters their vault was created under, and migrated on next login.

---

## 3. Request and trust flow

```
Browser (all crypto; keys in memory only)
   │  HTTPS
   ▼
Cloudflare  ── DDoS protection, TLS at the edge, origin IP hidden
   │  HTTPS — origin certificate; EC2 security group admits 443 only from Cloudflare IP ranges
   ▼
nginx (reverse proxy, same host as API)
   │  ── terminates origin TLS, rate limits, blocks /metrics externally
   │  Docker bridge network
   ▼
FastAPI (API container)  ── bound to the Docker network only, never published to the host
   │  PostgreSQL wire protocol over SSL
   ▼
PostgreSQL
   ├─ self-host: containerized Postgres on the same compose network
   └─ production: AWS RDS in a private subnet, no public address, reachable only from the API's security group
```

Each hop narrows what is reachable:

- **Cloudflare** is the only thing the public internet talks to. The origin IP is hidden, and DDoS/TLS are handled at the edge.
- The **EC2 security group** admits port 443 only from Cloudflare's published IP ranges, so even though the origin IP exists, traffic from anywhere else is dropped. SSH (22) is admitted only from the operator's address.
- **nginx** is the only process bound to a host port. The API container is published only to the internal Docker network (`expose`, not `ports`), so nothing outside the host can reach the API directly — it is always behind the proxy.
- **RDS** has no public address and lives in a private subnet. Its security group admits 5432 only from the API's security group — an **identity-based** rule, not an IP range, so it keeps working regardless of the API instance's address.

This is defense in depth: an attacker has to defeat several independent controls, not one.

---

## 4. Secrets

Three secrets exist: the server-side `PEPPER`, the `JWT_SECRET`, and the `DATABASE_URL` (which embeds the DB password).

The application reads all three from **environment variables** through a single `get_secret()` function. The application makes **no cloud API calls** — it does not know or care where the values came from. This is the seam that keeps it cloud-agnostic.

How the environment is populated differs by deployment:

- **Self-host:** the operator sets the variables directly — a `.env` file, Docker secrets, or their orchestrator's mechanism.
- **Production (AWS):** the three secrets live in **AWS Secrets Manager**. The EC2 instance has an **IAM role** whose policy grants `secretsmanager:GetSecretValue` on **exactly the three secret ARNs** and nothing else (least privilege). At deploy time the values are fetched via that role and written into the container's environment.

This is a deliberate **deploy-time injection** model rather than a runtime fetch. The tradeoff is discussed in the [threat model](../THREAT_MODEL.md); a runtime fetch with caching is noted as a future enhancement.

---

## 5. Infrastructure as code

The entire AWS deployment is provisioned by **Terraform**, organized into four modules with explicit dependencies so Terraform builds them in the correct order. Outputs from one module feed the inputs of the next.

- **networking** — VPC, one public subnet (for the API host), two private subnets across two availability zones (RDS requires a subnet group spanning two AZs), internet gateway, route table, and the two security groups (API and RDS). Outputs the subnet and security-group IDs.
- **database** — the RDS subnet group and the PostgreSQL instance, placed in the private subnets with the RDS security group. Automated backups are enabled; retention is set via a variable (free-tier constrained at present). Consumes networking's outputs.
- **secrets** — the three Secrets Manager secrets. The database URL secret is assembled from the RDS endpoint output, so it is always consistent with the actual database.
- **compute** — the IAM role, least-privilege policy, instance profile, the EC2 instance (with user-data that installs Docker), and an Elastic IP for a stable origin address. Consumes the subnet, security group, and secret ARNs.

The dependency chain (networking → database → secrets → compute) is expressed through Terraform variable passing, so a single `terraform apply` brings up the whole stack in order, and `terraform destroy` tears it down.

State is currently local. Moving it to an S3 backend with locking is a documented next step, required before CI/CD runs Terraform.

---

## 6. The two deployment targets

The same application image serves both targets. The only thing that changes is where the database and secrets come from, and both are controlled entirely by environment variables.

| Concern   | Self-host (Docker Compose)            | Production (AWS)                                  |
|-----------|----------------------------------------|--------------------------------------------------|
| Database  | Containerized Postgres on the compose network | Managed RDS in a private subnet           |
| Secrets   | Operator-supplied env vars             | Secrets Manager via EC2 IAM role, injected at deploy |
| TLS       | Operator's responsibility              | Cloudflare edge + nginx origin cert              |
| Selected via | `DATABASE_URL` and local `.env`     | `DATABASE_URL` pointing at RDS, env from Secrets Manager |

There is no application code difference between them. Swapping the containerized Postgres for managed RDS is a change to one environment variable. This is what makes the "runs anywhere" claim real rather than aspirational, and it is the property that makes adding new deployment targets (other clouds, bare metal) a provisioning-layer change rather than an application rewrite.

---

## 7. Concurrency

Vault writes use **optimistic concurrency control**. A client reads the vault at version *N*. When it writes back, it sends *N*. The server increments to *N+1* only if its stored version still equals *N*; otherwise it returns `409 Conflict`.

This makes the system **conflict-detecting, not conflict-merging**. Two devices editing concurrently will not silently clobber each other — the second writer is told its base is stale and must re-read. What the system does *not* do is merge the two sets of changes; that would require per-entry structure the server deliberately cannot see, since the vault is an opaque blob. The multi-device implications are covered in the [threat model](../THREAT_MODEL.md).

---

## 8. Known architectural limitations

These are consequences of deliberate scope decisions, each expanded in the [threat model](../THREAT_MODEL.md):

- **Single-blob vault** — the price of the server being unable to see entry structure is that there is no server-side per-entry merge, search, or sharing.
- **In-memory rate limiting** — resets on restart, not shared across instances; a shared store (e.g. Redis) is the production fix.
- **Deploy-time secret injection** — simpler than runtime fetch, but secrets are present in the process environment.
- **Stateless JWT** — sessions cannot be revoked before expiry; mitigated by short token lifetime and in-memory-only client storage.
- **No MFA** — interacts non-trivially with the zero-knowledge login flow; scoped to future work.
