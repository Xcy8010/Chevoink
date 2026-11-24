CREATE INDEX "admin_email_recipients_user_id_state_attempted_at_idx"
ON "admin_email_recipients" ("user_id", "state", "attempted_at");
