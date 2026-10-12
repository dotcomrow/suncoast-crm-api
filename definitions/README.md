# Managed custom-object definitions

This directory is the only schema-management input for logical custom objects. The Kubernetes database migration Job reads these files once per deployment. The API exposes records and read-only definition discovery, but no schema mutation endpoints.

Rules:

1. Give each object its own directory.
2. Start with `001-initial.json`, `kind: CustomObjectDefinition`, and `metadata.version: 1`.
3. Add changes in contiguous files such as `002-add-preference.json` using `kind: CustomObjectMigration`.
4. Never edit, rename, or remove an applied file. Its filename and SHA-256 checksum are stored in Yugabyte.
5. Migrations are additive. Replace a field by adding a new field, backfilling consumers, and deprecating the old field rather than changing or deleting it.
6. Use `contact_properties` only with `one_per_contact`. Use `local` for one-to-many data. Use `provider_custom_object` only when the configured provider subscription supports native custom objects.

Example additive migration:

```json
{
  "apiVersion": "crm.suncoast.systems/v1",
  "kind": "CustomObjectMigration",
  "metadata": {
    "name": "component_preferences",
    "version": 2
  },
  "spec": {
    "add_fields": [
      {
        "name": "preferred_format",
        "label": "Preferred Format",
        "type": "enumeration",
        "options": [
          { "label": "HTML", "value": "html" },
          { "label": "Plain text", "value": "text" }
        ]
      }
    ]
  }
}
```
