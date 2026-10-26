# Suncoast CRM API

A provider-neutral CRM service for the Suncoast platform. Applications use one stable `/v1` API while provider-specific behavior is isolated behind `CrmProvider`. EspoCRM is the configured provider.

## API behavior

The service supports contacts, companies, deals, activities, local custom-object records, operation status, and AI summaries. Writes return `202 Accepted` and an operation URL. The API commits the operation and outbox message atomically before returning, and the worker performs the provider write asynchronously.

Every write requires an `Idempotency-Key` header of at least eight characters. Retryable provider failures use durable Kafka delays of 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, and 24 hours. Later retries remain at 24 hours until `PROVIDER_MAX_ATTEMPTS` is reached, after which the command is written to the DLQ.

The OpenAPI contract is available at `/crm/openapi.json` when routed through the cluster ingress.

External signup integrations use `POST /v1/external-signups/contacts`. This
explicit endpoint queues the provider-neutral contact creation immediately and
sends a linked one-time confirmation link to `properties.email` (or the native
`properties.emailAddress` alias). Callers should supply a stable `subject_id`
for the person. Reusing that subject attaches additional addresses to the same
contact; omitting it falls back to an email-scoped identity. For the
`notifications` purpose, contact creation is idempotent per stable subject while
verification attempts retain their own idempotency keys. `primary_email=true`
explicitly promotes an address; otherwise the first address stays primary. Generic
`POST /v1/contacts` remains suitable for internal integrations and does not send
email automatically.
The deployment manifest enables this external-only workflow with
`EXTERNAL_SIGNUP_EMAIL_VERIFICATION_ENABLED=true`.

Each address has independent pending, verified, or expired state. The EspoCRM
adapter merges it into the Contact's native multi-address email field without
dropping existing addresses and writes the verification state to a related
`CContactEmail` record. The local contact representation exposes all entries in
`email_addresses`; the legacy scalar email and verification properties describe
the primary address only.

## EspoCRM provider

The adapter maps the stable entity families as follows:

| API entity | EspoCRM entity |
| --- | --- |
| contacts | `Contact` |
| companies | `Account` |
| deals | `Opportunity` |
| activities | `Task` |

It authenticates as a dedicated EspoCRM API User using `X-Api-Key`. Common property aliases are translated to EspoCRM fields and other properties pass through as EspoCRM field names.

Create retries are replay-safe through the custom `cSuncoastCrmId` field. Create that varchar field on Contact, Account, Opportunity, and Task and make it available to the API User before enabling traffic. Association writes fail explicitly until the provider-neutral association model is mapped to EspoCRM links.

Local custom-object storage is supported. The `contact_properties` and `provider_custom_object` modes are not supported by this adapter because EspoCRM Entity Manager changes are stored as deployable files in its `custom` directory.

## Durable storage and caching

The provider-neutral CRM facade stores entities, operations, idempotency records, its transactional Kafka outbox, and local custom objects in the durable `suncoast_crm` PostgreSQL database. Redis is a disposable cache for entity reads. Cache misses and Redis failures fall back to PostgreSQL, and successful provider writes invalidate affected keys. Redis never owns operation, outbox, retry, consent, or custom-object source data.

The Redis client discovers the writable node through Sentinel at `redis-sentinel.redis.svc.cluster.local:26379`, uses master name `mymaster`, and reads its password from Vault path `secret/redis`. Cached entries expire after 120 seconds by default.

## Deployment and database isolation

Kubernetes resources live in `manifests/`. EspoCRM runs in namespace `crm` as a StatefulSet with a persistent volume for application customizations and data files.

The CRM facade and EspoCRM share the PostgreSQL server already used by Directus, but neither shares the Directus database or role:

- Directus remains in database `directus` and schema `directus`.
- The facade uses database `suncoast_crm`, schema `crm`, and login role `suncoast_crm_app`.
- EspoCRM uses database `espocrm` and login role `espocrm_app`.
- The facade reaches PostgreSQL through a dedicated, redundant in-cluster SSH tunnel service.
- EspoCRM reaches PostgreSQL through its own SSH tunnel on pod-local port `15433`.
- The bootstrap Job records the Directus database OID and owner before provisioning and verifies they are unchanged afterward.
- The EspoCRM role is constrained to `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOREPLICATION`, with a connection limit and timeouts.
- Public access to the EspoCRM database and its `public` schema is revoked.

The bootstrap is fail-closed: it refuses to reuse either application database when it has an unexpected owner. It records the Directus database identity before provisioning and proves that identity is unchanged afterward. The PostgreSQL host is a small shared production server, so capacity and backups should be reviewed before syncing into production.

The required Vault values are:

| Vault path/property | Purpose |
| --- | --- |
| `secret/suncoast-crm-api:espocrm_api_key` | CRM API access to EspoCRM |
| `secret/suncoast-crm-api:espocrm_admin_password` | Initial EspoCRM administrator password |
| `secret/suncoast-crm-api:espocrm_database_password` | Generated/preserved database role password |
| `secret/suncoast-crm-api:facade_database_password` | Generated/preserved facade database role password |
| `secret/redis:password` | Existing Redis/Sentinel password |
| Directus tunnel secret leaf paths | Reused only to reach the shared PostgreSQL host |

The deployment uses `espocrm/espocrm:10.0.10`. Image changes should be reviewed alongside EspoCRM release notes and database compatibility guidance.

## Resource order

Argo sync waves establish this order:

1. Namespace, Vault bootstrap, ServiceAccounts, and RBAC.
2. Vault-backed ExternalSecrets and application configuration.
3. The isolated facade and EspoCRM database bootstrap plus PostgreSQL tunnel.
4. Database migrations and custom-object definition reconciliation.
5. Kafka topic reconciliation.
6. CRM API, worker, and EspoCRM workloads.
7. Services, ingress, and autoscaling resources.

The cleanup migration `004_remove_retired_workflows.sql` removes the unused provider-specific form, email-validation, and notification tables and any queued form commands. It does not touch Directus or EspoCRM application tables.

## Local development

```bash
npm ci
npm test
npm run build
```

Required runtime settings include `DATABASE_URL`, Kafka credentials, `CRM_PROVIDER=espocrm`, `ESPOCRM_BASE_URL`, and `ESPOCRM_API_KEY`. See `manifests/20-config.yaml` for non-secret defaults.

## GitOps boundary

Repository changes do not deploy themselves. A commit and push update source state; Argo sync and workload health must be verified separately. No production database or cluster mutation should be inferred from local validation.
