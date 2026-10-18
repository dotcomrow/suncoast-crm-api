DELETE FROM crm_outbox WHERE payload->>'action' = 'form.submit';
DELETE FROM crm_operations WHERE action = 'form.submit';

DROP TABLE IF EXISTS crm_email_validation_user_actions;
DROP TABLE IF EXISTS crm_email_validation_action_defaults;
DROP TABLE IF EXISTS crm_email_validation_action_registry;
DROP TABLE IF EXISTS crm_email_validations;
DROP TABLE IF EXISTS crm_form_submissions;
DROP TABLE IF EXISTS crm_notification_outbox;
