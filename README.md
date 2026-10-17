# Suncoast CRM API

A provider-neutral CRM service for the Suncoast platform. Applications call one stable `/v1` API; provider-specific behavior is isolated behind `CrmProvider`. HubSpot is the first adapter.

## Architecture

```text
applications -> Gravitee -> CRM API -> Yugabyte transaction
                                      |-- operation record
                                      `-- transactional outbox -> Kafka crm.commands.v1
                                                                      |
                                                               CRM worker
                                                               |-- HubSpot adapter
                                                               |-- delayed Kafka retries
                                                               |-- terminal failure email
                                                               `-- Ollama (opt-in jobs)
                                                                      |
                                     Yugabyte projection + crm.events.v1 / DLQ
```

Writes return `202 Accepted` and an operation URL. The API commits the operation and outbox message atomically before returning. The outbox publishes to Kafka with all-replica acknowledgement. The worker updates HubSpot, then updates the local Yugabyte projection. Callers can safely retry using the same `Idempotency-Key`. Retryable failures use delays of 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, and 24 hours; later retries remain at 24 hours. The default 30 attempts keep trying for roughly 24 days. The first HubSpot failure generates one warning email, while a terminal failure is sent to the DLQ and generates a separate error email. Both emails use a durable notification outbox that retries until the platform notification API accepts delivery. The recipient is configured with `HUBSPOT_FAILURE_NOTIFICATION_EMAIL` and defaults to `administrator@suncoast.systems`.

## Provider forms and double opt-in

Configured forms use the same durable operation, Yugabyte outbox, Kafka retry, DLQ, and administrator-notification path as CRM writes:

- `POST /v1/forms/{formName}/submissions` records the complete submission locally before returning `202`.
- `GET /v1/form-submissions/{submissionId}` returns the durable `queued`, `retrying`, `submitted`, or `failed` state.
- The HubSpot adapter calls the authenticated Forms API. When double opt-in is enabled for the selected HubSpot form/account, HubSpot sends its confirmation email.
- The local form-submission record is the immutable signup/consent event even while the person is unconfirmed. HubSpot remains authoritative for double-opt-in confirmation and marketing-subscription eligibility.

Set `HUBSPOT_PORTAL_ID` and `HUBSPOT_FORM_IDS` in `manifests/20-config.yaml` after creating the forms. `HUBSPOT_FORM_IDS` is a JSON map, allowing new purposes without new code, for example:

```yaml
HUBSPOT_PORTAL_ID: "12345678"
HUBSPOT_FORM_IDS: '{"newsletter":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","product-interest":"ffffffff-1111-2222-3333-444444444444","beta-signup":"55555555-6666-7777-8888-999999999999"}'
```

The submitted `fields` names must match fields on the selected HubSpot form. If HubSpot privacy/consent collection is enabled, submit the user-visible consent text and subscription type through the optional `consent` object; the API only accepts affirmative consent values. Do not treat a successful Forms API submission as double-opt-in confirmation: `submitted` means HubSpot accepted the form and the contact may still be awaiting the confirmation click.

The provider-neutral email-validation facade builds on those forms:

- `POST /v1/email-validations` accepts an `email`, a configured `purpose` such as `newsletter`, and optional form fields/context/consent. It returns a durable validation ID with `status: pending`.
- `GET /v1/email-validations/{validationId}` refreshes HubSpot's automatically managed `hs_emailconfirmationstatus` and changes the local state to `validated` only for one of HubSpot's confirmed double-opt-in states. Pass `?refresh=false` to read only the stored state.
- Downstream newsletter, update, or other subscription records should retain the validation ID and remain pending unless this endpoint returns `status: validated`. A submitted form or a HubSpot contact ID is not validation proof.

HubSpot does not expose a general mailbox-deliverability validator through this integration. This API represents ownership/consent confirmation through HubSpot double opt-in. The HubSpot private app needs contact read access in addition to the existing form submission access so the adapter can inspect the confirmation property.

Terminal validation outcomes are evaluated by the dedicated `email-validation-policy` KIE container. Git-managed mandatory/default actions are combined with additive per-user actions configured through `GET|PUT /v1/email-validation-action-config/users/{userId}`. Drools validates and snapshots the plan; the database transaction that changes the validation state then emits `crm.email-validation.events.v1` and one idempotent command per action on `crm.email-validation.actions.v1`. Keep `EMAIL_VALIDATION_RULES_ENABLED=false` until the KJAR is published and registered, then enable it in a separate reviewed rollout.

## Custom objects

Custom-object schemas are Git-managed deployment assets under `definitions/`; there is no runtime HTTP endpoint that can create or alter them. The single database migration Job validates and reconciles those files after applying SQL migrations, before the API and worker deploy. It records each object name, integer version, filename, and SHA-256 checksum in `crm_custom_object_definition_migrations`. An edited applied file, a skipped version, or an incompatible field definition fails the deployment.

Version 1 is a complete `CustomObjectDefinition` file. Later versions are immutable `CustomObjectMigration` files that may add fields. Destructive rename, removal, and type mutation are intentionally unavailable. Every definition selects one storage mode while retaining the same record API facade:

- `local` (default): Yugabyte is authoritative and no provider custom-object entitlement is required. This supports multiple records per contact.
- `contact_properties`: Yugabyte is authoritative and fields are projected into namespaced, hidden HubSpot contact properties. This requires `one_per_contact` cardinality.
- `provider_custom_object`: HubSpot receives a native custom-object schema and records. This is reserved for subscriptions that include HubSpot custom objects.

Provider-native custom objects receive reserved `suncoast_crm_id` and `suncoast_contact_id` properties. Contact-property projections use deterministic names beginning with `suncoast_`; those properties are not merged into the ordinary contact representation returned by this API.

All definitions share one stable record API:

- `GET|POST /v1/custom-objects/{objectName}/records`
- `GET|PATCH|DELETE /v1/custom-objects/{objectName}/records/{recordId}`

Every record requires `contact_id`. The service verifies that it identifies a live canonical CRM contact, enforces the registered field types, writes through the durable operation/Kafka pipeline, and maintains the Yugabyte projection. Applications never receive database credentials and do not need new service code when another definition is registered.

To add a logical table, add `definitions/<object-name>/001-initial.json`. To evolve it, add the next contiguous file such as `002-add-source.json`; never edit an applied file. The directory intentionally contains no application definitions until a component needs durable state beyond the canonical CRM entities and form-submission ledger. The read-only `GET /v1/custom-objects` and `GET /v1/custom-objects/{objectName}` endpoints expose active contracts, but schema management is only available to the deployment Job through packaged files.

The `local` mode requires no additional HubSpot scope. `contact_properties` requires the existing contact read/write and `crm.schemas.contacts.write` scopes. Native `provider_custom_object` mode requires an account edition that includes custom objects plus `crm.schemas.custom.read`, `crm.schemas.custom.write`, `crm.objects.custom.read`, and `crm.objects.custom.write`.

Kafka gives at-least-once delivery, not exactly-once provider writes. The HubSpot adapter therefore upserts contacts, companies, and deals by the unique `suncoast_crm_id` property. Activities map to notes and use HubSpot's existing writable, unique `hs_unique_id` property. The setup Job creates missing properties in HubSpot's existing standard groups and validates existing properties; it never creates property groups or modifies the notes schema. A retried create therefore resolves to the same HubSpot record.

## Stable API

- `GET|POST /v1/{contacts|companies|deals|activities}`
- `GET|PATCH|DELETE /v1/{entityType}/{entityId}`
- `GET /v1/operations/{operationId}`
- `POST /v1/ai/summaries`
- `GET /openapi.json`, `/healthz`, and `/readyz`

This deployment is single-tenant. Every request is assigned to the configured `CRM_TENANT_ID` (`suncoast` by default); callers do not provide a tenant header. Every write requires an `Idempotency-Key` of at least eight characters. Provider IDs are returned as metadata but are never used in external API paths.

Example:

```bash
curl -X POST https://gateway.example/crm/v1/contacts \
  -H 'Authorization: Bearer ...' \
  -H 'Idempotency-Key: contact-import-0001' \
  -H 'Content-Type: application/json' \
  -d '{"properties":{"email":"person@example.com","firstname":"Pat"}}'
```

## Add another provider

Implement `CrmProvider` in `src/providers/`, add it to `src/providers/registry.ts`, then select it with `CRM_PROVIDER`. Do not add provider-specific fields to the path or top-level contract; translate stable `properties` and `associations` inside the adapter. A later per-tenant provider configuration can replace the current deployment-wide provider selection without changing the public API.

The initial HubSpot adapter supports property CRUD for contacts, companies, deals, and activities (mapped to HubSpot notes). Association writes are reserved in the stable schema but fail explicitly until stable association names are mapped to HubSpot association type IDs; they are never silently discarded.

The HubSpot Service Key must grant read/write access to contacts, companies, deals, and notes and the available schema/property write permissions needed for contacts, companies, and deals. `manifests/25-hubspot-setup.yaml` creates or validates the required `suncoast_crm_id` properties and validates the built-in notes property as an Argo Sync hook. The Vault value does not need to change when HubSpot keeps the same key.

## Local development

Node.js 22 and PostgreSQL-compatible Yugabyte are required.

```bash
npm install
export DATABASE_URL='postgresql://user:password@localhost:5433/crm'
npm run build
npm run migrate
npm test
npm start
```

Run the worker separately with `npm run worker`. Kafka auto-topic creation is deliberately disabled; the Kubernetes bootstrap described below creates these topics:

- `crm.commands.v1` — durable work requests
- `crm.commands.retry.{1m|5m|30m|2h|6h|24h}.v1` — delayed retry stages
- `crm.events.v1` — completion events
- `crm.commands.dlq.v1` — terminal failures

The Kubernetes setup grants the CRM principal full access to all command, retry, event, and DLQ topics and read/describe access to consumer group `suncoast-crm-provider-workers-v1`. Kafka has no native scheduled delivery, so the transactional Yugabyte outbox holds each retry until its due time, publishes it to the matching retry topic, and the worker consumes every retry topic with the same consumer group.

## Persistent secrets in Vault

The HubSpot Service Key is not generated by this repository. It remains stored at KV v2 path `secret/suncoast-crm-api` using the platform-standard `value` property:

```text
secret/suncoast-crm-api
  value               HubSpot Service Key
```

Kafka credentials and ACL declarations use the same dedicated Vault paths as the platform Kafka security reconciler:

```text
secret/kafka-scram-user-suncoast-crm-api                   value = suncoast-crm-api
secret/kafka-scram-user-suncoast-crm-api-password          value = generated password
secret/kafka-scram-user-suncoast-crm-api-topic-all         value = CRM topic CSV
secret/kafka-scram-user-suncoast-crm-api-group-read        value = consumer group
secret/kafka-scram-user-suncoast-crm-api-group-describe    value = consumer group
secret/kafka-scram-user-suncoast-crm-api-cluster-describe  value = true
secret/platform-notification-service/clients/suncoast-crm-api  token = generated token
```

`manifests/17-kafka-vault-bootstrap.yaml` creates missing Kafka values, preserves credentials, reconciles the Kafka topic declaration, creates the durable notification client token if absent, and configures Vault policy/auth role `suncoast-crm-api`. `manifests/10-secrets.yaml` maps the HubSpot, Kafka, and notification credentials into the application Secret. The bootstrap never changes the manually supplied HubSpot Service Key. The notification service must include `suncoast-crm-api` in `NOTIFICATION_INTAKE_TRUSTED_CLIENT_KEYS`.

HubSpot warning and terminal-failure emails use the published Directus templates `crm.hubspot.operation.retrying` and `crm.hubspot.operation.failed`. The notification service publishes rendered requests to the platform-standard `platform.notifications.requested.v1` topic; the existing NiFi notification flow consumes that shared topic and routes the email delivery.

## Kafka bootstrap

Kafka follows the platform pattern used by the `k8s-ollama` async service and the central `k8s-kafka` security reconciler:

1. `manifests/17-kafka-vault-bootstrap.yaml` idempotently creates the CRM Kafka principal, a generated durable SCRAM password, topic/group ACL declarations, and the External Secrets Vault role.
2. The central `kafka-security-reconciler` discovers the `kafka-scram-user-*` paths and creates the SCRAM principal and ACLs. It normally runs every five minutes and intentionally ignores brand-new values briefly.
3. The CRM ExternalSecret materializes the username and password in namespace `crm`.
4. `manifests/18-kafka-topic-setup.yaml` waits up to 12 minutes for the broker and reconciler, then creates or updates the command, retry, event, and DLQ topics with explicit partition, retention, segment, cleanup, and minimum-ISR settings.

The topic setup uses three partitions and replication factor one, matching the current resource-constrained platform. Command retention is 7 days, event retention is 14 days, and retry/DLQ retention is 90 days so a prolonged worker outage does not discard delayed work. Increase replication only after the Kafka cluster has enough brokers. The setup assumes the platform `kafka-security-reconciler` CronJob from `k8s-kafka` is deployed and healthy.

## Yugabyte bootstrap

Yugabyte is provisioned automatically during Argo sync using the same fixed-login/Vault-rotation pattern as `k8s-ollama`:

1. `manifests/15-yugabyte-bootstrap.yaml` runs in namespace `vault`, where the existing `vault-root-token` Secret and `secret/vaultadmin` password are available.
2. The idempotent Job creates database `suncoast_crm`, login `suncoast_crm_login`, and schema `crm` if they do not exist.
3. It registers Vault database static role `yugabyte-db/static-roles/suncoast-crm-login` with a 30-day rotation period.
4. It creates a read-only Vault policy and Kubernetes auth role for service account `crm/crm-db-secret-sync`.
5. `manifests/16-yugabyte-secret-sync.yaml` authenticates to Vault using that service account, reads the rotating username/password, and renders Kubernetes Secret `crm/suncoast-crm-database` with a URL-encoded `DATABASE_URL`.
6. The migration Job consumes that Secret and creates `crm_entities`, `crm_operations`, `crm_outbox`, the durable `crm_notification_outbox`, and the custom-object definition/record/migration-ledger tables in schema `crm`.
7. The same single Job reads the packaged `definitions/` directory, validates immutable version sequences and checksums, then reconciles Yugabyte and any configured HubSpot contact-property projections before application workloads start.

No Yugabyte password or connection URL needs to be entered manually. The bootstrap assumes these existing platform dependencies:

```text
Vault root token Secret:  vault/vault-root-token
Vault Yugabyte admin KV:  secret/vaultadmin, property value
Vault database mount:     yugabyte-db
Vault DB connection name: yugabyte
Yugabyte service:         yb-tserver-service.yugabyte.svc.cluster.local:5433
```

An initial Argo Sync hook creates the database Secret before migration. An hourly CronJob refreshes it after Vault rotation. Stakater Reloader is expected to restart the API and worker after the Secret changes.

## Kubernetes and Gravitee

Apply `manifests/` through Argo CD. The Service annotations let the existing Gravitee annotation controller create `/crm`, configure a health check, and refresh the generated `/openapi.json` every five minutes. Workloads use the operator-managed `latest` image tag with `imagePullPolicy: Always`; restart or resync the workloads after publishing a replacement image.

The GitHub repository is private, so make the GHCR package readable by the cluster or attach a valid `imagePullSecret` to the `suncoast-crm-api` service account before the first sync.

The API has two replicas and a disruption budget. The worker starts with one replica because the server is resource constrained; Kafka consumer groups allow horizontal scaling later. Redis is not required in the first version—Yugabyte is the source of truth and the transactional outbox avoids a second consistency domain. Add Redis only for measured read pressure or rate limiting.

Ollama integration is opt-in through `OLLAMA_ENABLED`. This deployment uses the locally available `qwen3:14b` model. AI work uses the same durable operation queue and stores the generated summary in the operation result. It does not silently mutate CRM fields or send data to an external AI provider.

## Delivery guarantees and operations

- API success means the command is stored in Yugabyte, not that HubSpot already accepted it.
- `succeeded` means the worker completed the provider/AI call and stored its result.
- Retryable provider/network failures are retried by Kafka up to `PROVIDER_MAX_ATTEMPTS`.
- Worker claims use a lease; a pod crash leaves work recoverable after `PROCESSING_LEASE_SECONDS` instead of permanently stuck in `processing`.
- Invalid Kafka commands are preserved on `crm.commands.dlq.v1` instead of terminating the worker.
- Terminal failures go to `crm.commands.dlq.v1` and remain visible on the operation.
- Logs never intentionally print access tokens or full request bodies.

For production proof, verify separately: image build/push, Argo sync, migration completion, topic/ACL readiness, `/readyz`, Gravitee `/crm/openapi.json`, one create operation reaching `succeeded`, the matching HubSpot object, and an event on `crm.events.v1`.
